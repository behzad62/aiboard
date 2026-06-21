/**
 * Build mode: the Architect-orchestrated project loop.
 *
 * The judge model acts as the Architect (planner/reviewer); the other selected
 * models are workers. This module holds the shared vocabulary: task types, the
 * Architect's JSON action protocol (with tolerant parsing), and every prompt.
 * The loop itself runs in lib/client/build-engine.ts.
 */

import { FILE_OUTPUT_INSTRUCTION, META_FOOTER_INSTRUCTION } from "./prompts";

export type BuildTaskStatus =
  | "planned"
  | "in_progress"
  | "review"
  | "fixing"
  | "done"
  | "failed";

export interface BuildTask {
  id: string;
  title: string;
  instructions: string;
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
  /** Failed attempts so far — the engine requeues a failed task once before
   * giving up on it. */
  failCount?: number;
  /** Epoch milliseconds before this task may be retried after transient failure. */
  retryAfterMs?: number;
}

export const BUILD_TASK_MAX_FAILURES = 3;
export const BUILD_TASK_TRANSIENT_RETRY_DELAYS_MS = [15_000, 45_000];

export interface BuildTaskFailureDecision {
  failCount: number;
  status: "fixing" | "failed";
  instructionNote: string;
  retryDelayMs?: number;
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

export interface ReviewTaskFilterResult {
  accepted: PlanAction["tasks"];
  skipped: Array<{
    id: string;
    title: string;
    existingStatus: BuildTaskStatus;
  }>;
}

export function filterNovelReviewTasks(
  existingTasks: Pick<BuildTask, "id" | "title" | "status">[],
  candidates: PlanAction["tasks"]
): ReviewTaskFilterResult {
  const existing = new Map(
    existingTasks.map((task) => [
      task.id.trim().toLowerCase(),
      { title: task.title, status: task.status },
    ])
  );
  const accepted: PlanAction["tasks"] = [];
  const skipped: ReviewTaskFilterResult["skipped"] = [];
  for (const candidate of candidates) {
    const id = candidate.id?.trim();
    const key = id?.toLowerCase();
    const prior = key ? existing.get(key) : undefined;
    if (id && prior) {
      skipped.push({
        id,
        title: prior.title,
        existingStatus: prior.status,
      });
      continue;
    }
    accepted.push(candidate);
    if (id && key) {
      existing.set(key, {
        title: candidate.title,
        status: "planned",
      });
    }
  }
  return { accepted, skipped };
}

export interface BalancedWorkerSelectionInput {
  activeWorkerIndexes: number[];
  assignmentCounts: Map<number, number>;
  assignCursor: number;
  pinnedIndex?: number | null;
  requestedIndex?: number | null;
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

  const minAssigned = Math.min(
    ...active.map((index) => input.assignmentCounts.get(index) ?? 0)
  );
  const requestedCount =
    input.requestedIndex != null
      ? input.assignmentCounts.get(input.requestedIndex) ?? 0
      : Number.POSITIVE_INFINITY;
  if (
    input.requestedIndex != null &&
    activeSet.has(input.requestedIndex) &&
    requestedCount <= minAssigned
  ) {
    return assign(input.requestedIndex, input.assignCursor, false, true);
  }

  const eligible = active.filter(
    (index) => (input.assignmentCounts.get(index) ?? 0) === minAssigned
  );
  const chosen = eligible[input.assignCursor % eligible.length] ?? active[0];
  return assign(chosen, input.assignCursor + 1, false, false);
}

export function buildReviewFixTaskUpdate(
  task: BuildTask,
  fixInstructions: string | undefined,
  priorFiles: string[],
  maxContextFiles: number
): BuildTask {
  const contextFiles = [
    ...new Set([...task.contextFiles, ...priorFiles]),
  ].slice(0, maxContextFiles);
  return {
    ...task,
    status: "fixing",
    workerIndex: undefined,
    assignTo: undefined,
    contextFiles,
    instructions: `${task.instructions}\n\nFIX (from the Architect's review): ${
      fixInstructions ?? "address the review feedback"
    }`,
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

export interface PlanAction {
  action: "plan";
  tasks: Array<{
    id?: string;
    title: string;
    instructions: string;
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

export interface ReviewAction {
  action: "review";
  results: Array<{
    taskId: string;
    verdict: "approve" | "fix";
    fixInstructions?: string;
  }>;
  newTasks?: PlanAction["tasks"];
  done: boolean;
  notes?: string;
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
export function detectVerifyCommand(files: string[]): string {
  const has = (re: RegExp) => files.some((f) => re.test(f));
  if (has(/(^|\/)go\.mod$/)) return "go build ./...";
  if (has(/(^|\/)Cargo\.toml$/)) return "cargo check";
  if (has(/\.csproj$/) || has(/\.fsproj$/) || has(/\.sln$/)) return "dotnet build";
  if (has(/(^|\/)pom\.xml$/)) return "mvn -q -DskipTests compile";
  if (has(/(^|\/)mix\.exs$/)) return "mix compile";
  // C/C++: configure into a scratch dir, then build (&& works in cmd and sh).
  if (has(/(^|\/)CMakeLists\.txt$/))
    return "cmake -S . -B .verify-build && cmake --build .verify-build";
  if (has(/(^|\/)Makefile$/)) return "make";
  if (has(/(^|\/)tsconfig\.json$/)) return "npx --yes tsc --noEmit";
  // Python: stdlib byte-compile catches syntax errors; no deps assumed.
  if (has(/\.py$/)) return "python -m compileall -q .";
  return "";
}

/** A compact worker-performance line for the prompt scoreboard. */
export function scoreboardSection(scoreboard?: string): string {
  return scoreboard?.trim()
    ? `Worker performance so far (the engine tracks this automatically from your approve/fix verdicts, failures, and output speed relative to the other workers — higher score = more reliable). Use assignTo sparingly as a worker preference only when a task truly needs that model; otherwise omit it so the engine balances work across the selected workers. Benched workers won't be given tasks:\n${scoreboard}`
    : "";
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

export const RUNS_PER_PHASE = 8;
export const TOTAL_RUNS = 24;

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

export type ArchitectAction =
  | ReadAction
  | ReadRangeAction
  | PlanAction
  | ReviewAction
  | RunAction
  | SearchAction
  | ToolAction
  | FetchAction
  | PatchAction
  | AppendAction
  | RepoStatusAction
  | RepoDiffAction
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
  task: Pick<BuildTask, "id" | "title">;
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

function parseActionCandidate(candidate: string): ArchitectAction | null {
  try {
    const parsed = JSON.parse(candidate) as Partial<ArchitectAction>;
    if (parsed && typeof parsed === "object" && "action" in parsed) {
      const actionName = (parsed as { action?: unknown }).action;
      if (actionName === "read_file") {
        const readFile = parsed as { path?: unknown; paths?: unknown };
        const paths = Array.isArray(readFile.paths)
          ? readFile.paths.filter((p): p is string => typeof p === "string")
          : typeof readFile.path === "string"
            ? [readFile.path]
            : [];
        if (paths.length > 0) return { action: "read", paths };
      }
      if (parsed.action === "read" && Array.isArray((parsed as ReadAction).paths)) {
        return parsed as ReadAction;
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
      if (parsed.action === "plan" && Array.isArray((parsed as PlanAction).tasks)) {
        return parsed as PlanAction;
      }
      if (parsed.action === "review") {
        const review = parsed as ReviewAction;
        return {
          ...review,
          results: Array.isArray(review.results) ? review.results : [],
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
    }
  } catch {
    // not a valid action candidate
  }
  return null;
}

export function isBuildToolAction(action: ArchitectAction): boolean {
  return (
    action.action === "read" ||
    action.action === "read_range" ||
    action.action === "search" ||
    action.action === "patch" ||
    action.action === "append" ||
    action.action === "run" ||
    action.action === "tool" ||
    action.action === "fetch" ||
    action.action === "repo_status" ||
    action.action === "repo_diff" ||
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
    action.action === "search" ||
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
  const actions = uniqueActionCandidatesInDocumentOrder(text)
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

function looksLikeIncompleteToolAction(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!/"action"\s*:\s*"(?:read|read_range|search|patch|append|run|shell|tool|fetch|repo_status|repo_diff|repo_branch_create|repo_commit|repo_issue_list|repo_milestone_create|repo_issue_create|repo_issue_read|repo_push|repo_pr_create)"/i.test(trimmed)) {
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

export const DUPLICATE_TOOL_CALL_FEEDBACK =
  "DUPLICATE TOOL CALL REJECTED: you already received this exact (or a fully overlapping) read/search/command result — it is already in this conversation above. Do not repeat it. Read a DIFFERENT range/file, search a different term, or produce your decision JSON now.";

export const FORCED_REVIEW_INSTRUCTION = [
  "STOP USING TOOLS. You have used your inspection budget for this review (or repeated the same lookups). Any further read/search/command requests will be IGNORED.",
  "Using ONLY the file contents, change digests, and tool results already in this conversation, produce your final review now as exactly ONE fenced ```json block matching the review schema.",
  "If a detail you wanted to inspect is still unknown, do NOT block on it: approve what demonstrably works and add a precise follow-up fix task (or a `fix` verdict with concrete instructions) for the rest.",
].join("\n");

export const FORCED_PLAN_INSTRUCTION = [
  "STOP USING TOOLS. You have used your inspection budget for planning. Any further read/search/command requests will be IGNORED.",
  "Using only what you already have, produce your plan now as exactly ONE fenced ```json block matching the plan schema.",
].join("\n");

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Bound a tool-loop conversation so it can never grow past a char budget. Keeps
 * the system + initial instruction (indices 0–1) and the most recent
 * `keepRecent` messages verbatim; older tool-result turns in between collapse
 * into a single placeholder. Returns a NEW array (input untouched) plus how many
 * messages were folded away, so the caller can log it.
 */
export function compactToolConversation<T extends ConversationMessage>(
  messages: T[],
  maxChars: number,
  keepRecent = 6
): { messages: T[]; compacted: number } {
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= maxChars || messages.length <= keepRecent + 3) {
    return { messages, compacted: 0 };
  }
  const head = messages.slice(0, 2);
  const tail = messages.slice(messages.length - keepRecent);
  const omitted = messages.length - head.length - tail.length;
  if (omitted <= 0) return { messages, compacted: 0 };
  const placeholder = {
    role: "user",
    content: `[${omitted} earlier tool exchange(s) omitted to stay within the context budget — rely on the file contents and results retained above and below; do not re-request them.]`,
  } as T;
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
function githubWorkflowDoc(enabled?: boolean, typedRepoAvailable?: boolean): string {
  if (!enabled) return "";
  if (typedRepoAvailable) {
    return [
      "GITHUB WORKFLOW SKILL - the user asked you to handle GitHub issue-to-PR work for the provided repository.",
      "Drive the whole workflow through the TYPED repo actions documented above (repo_issue_list, repo_milestone_create, repo_issue_create, repo_issue_read, repo_branch_create, repo_commit, repo_push, repo_pr_create) — never raw shell commands for issues, milestones, commits, pushing, or opening pull requests.",
      "If the user asks to create milestones/issues, create REAL GitHub milestones/issues with repo_milestone_create and repo_issue_create; do not substitute local roadmap markdown files.",
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
    "TOOL — repo (Git): the runner folder is a Git repository. Use these TYPED actions for repo operations instead of running raw `git`/`gh` commands. Emit exactly one JSON action per turn and wait for the result before the next.",
    '- Status: {"action":"repo_status","reason":"why"} — current branch, dirty file counts, and ahead/behind. Non-mutating; re-query freely after writes.',
    '- Diff: {"action":"repo_diff","paths":["optional/scope"],"staged":false,"stat":false,"reason":"why"} — a bounded diff; "stat" gives a summary, "staged" diffs the index. Non-mutating.',
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
  typedRepoAvailable?: boolean
): string {
  if ((!runsLeft || runsLeft <= 0) && !githubWorkflow) return "";
  return [
    "TOOL — run commands: the user granted you a local runner that executes shell commands in the project folder. Use it to install dependencies, run tests, build, or inspect the environment. To run a command, respond with ONLY:",
    '{"action":"run","command":"npm test","reason":"verify the suite passes"}',
    "Commands must NOT edit project files: do not use fs.writeFileSync, redirection, Set-Content, sed -i, rm/move/copy, or scripts that modify source files. Use patch/append/edit output for file changes, then run commands only to verify or inspect.",
    githubWorkflowDoc(githubWorkflow, typedRepoAvailable),
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

export function buildArchitectPlanPrompt(input: {
  request: string;
  treeText: string;
  fileContext: string;
  maxTasks: number;
  workerNames: string[];
  readHopsLeft: number;
  runsLeft?: number;
  searchesLeft?: number;
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
  /** Hand-off summary from a previous pass — this is a follow-up build. */
  previousSummary?: string;
}): string {
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
    input.previousSummary?.trim()
      ? `\nThis is a FOLLOW-UP pass: a previous build already delivered the project summarized below. Everything delivered is still a requirement — preserve it. Plan ONLY the delta (changes the notes/request ask for), editing existing files where possible instead of rebuilding.\nPrevious hand-off summary:\n${input.previousSummary}`
      : "",
    input.fileContext,
    userNotesSection(input.userNotes),
    "",
    `Your workers: ${input.workerNames.join(", ")}.`,
    scoreboardSection(input.scoreboard),
    "",
    readOption,
    searchToolDoc(input.searchesLeft),
    runToolDoc(input.runsLeft, input.shellHint, input.githubWorkflow, input.repoWorkflow),
    fetchToolDoc(input.fetchesLeft),
    repoToolDoc(input.repoWorkflow, input.githubCli, input.githubWorkflow),
    mcpToolDoc(input.mcpToolsDoc, input.mcpCallsLeft),
    "",
    `To plan, respond with a short rationale followed by ONE fenced json block:`,
    "```json",
    `{"action":"plan","tasks":[{"id":"T1","title":"...","instructions":"complete, self-contained instructions — the worker sees nothing else","contextFiles":["existing files the worker must see"],"outputPaths":["every file this task may create or modify"],"expectedOutputs":"short prose summary of expected files or outcomes","dependsOn":["ids of tasks whose output this one needs, [] when independent"],"assignTo":"optional worker display name for this task (omit to auto-assign by performance)","difficulty":3}],"notes":"conventions all workers must follow","verifyCommand":"ONE non-interactive shell command that compiles or syntax-checks this project; it runs automatically after every wave and its errors come back to you. Match the stack: dotnet build | go build ./... | cargo check | npx --yes tsc --noEmit | cmake -S . -B .verify-build && cmake --build .verify-build | g++ -fsyntax-only src/*.cpp | php -l src/index.php | python -m compileall -q . | ./gradlew compileJava. Omit only when nothing meaningful can run."}`,
    "```",
    `verifyCommand must be a non-mutating verification command. It must not edit files; all source changes must go through worker output, patch, or append.`,
    `Rules: at most ${input.maxTasks} tasks this wave (you can add more after reviewing); make each task independently doable by one model in one response; put shared conventions (naming, stack, structure) in notes AND in each task's instructions.`,
    `Tasks run CONCURRENTLY whenever their "dependsOn" tasks are finished — maximize parallelism: keep dependsOn empty unless a task truly consumes another task's files, and prefer many independent tasks over one long chain. Workers cannot see each other's in-progress output, so each task must own its files exclusively.`,
    `List in every task's "outputPaths" ALL files it may create or modify; an integration/wiring/final-pass task that edits files produced by other tasks MUST name those tasks in its "dependsOn" — tasks with overlapping outputPaths are never run concurrently (the engine defers them), so omitting the dependency only stalls the wave, it cannot make them safe.`,
    `Rate each task's "difficulty" 1-5 honestly (1 = trivial boilerplate, 3 = typical feature, 5 = hard/architectural). It does not change who does the work — it weights the global model leaderboard so a model approved on a hard task outranks one approved on a trivial one. Be consistent across tasks.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildWorkerTaskPrompt(input: {
  request: string;
  treeText: string;
  task: BuildTask;
  contextFileText: string;
  architectNotes: string;
  toolInstructions?: string;
  verbosityInstruction?: string;
}): string {
  return [
    `You are an AI engineer on a team building a project. The Architect assigned you ONE task. Complete it fully — other tasks are handled by teammates, so do not do their work or restructure files outside your task.`,
    "",
    "Overall project request (for context only):",
    input.request,
    "",
    treeSection(input.treeText),
    input.architectNotes ? `\nArchitect's conventions:\n${input.architectNotes}` : "",
    input.contextFileText,
    "",
    `YOUR TASK — ${input.task.id}: ${input.task.title}`,
    input.task.instructions,
    input.task.outputPaths?.length
      ? `Files you may create or modify for this task: ${input.task.outputPaths.join(", ")}`
      : "",
    input.task.expectedOutputs ? `Expected outputs: ${input.task.expectedOutputs}` : "",
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

export function buildArchitectReviewPrompt(input: {
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
  mcpToolsDoc?: string;
  mcpCallsLeft?: number;
  fetchesLeft?: number;
  userNotes?: string;
  scoreboard?: string;
  /** One-line note about the runner's shell/OS (e.g. Windows cmd.exe). */
  shellHint?: string;
  githubWorkflow?: boolean;
  /** Whether a runner is connected to a Git repo — gates the typed repo doc. */
  repoWorkflow?: boolean;
  /** Runner's GitHub CLI state — gates the issue/push/PR typed-action docs. */
  githubCli?: { available: boolean; authenticated: boolean };
}): string {
  return [
    ARCHITECT_ROLE,
    "",
    "Project request from the user:",
    input.request,
    "",
    treeSection(input.treeText),
    input.fileContext?.trim()
      ? `\nFile contents you have already read — ground every decision in these; NEVER invent replacement content for an existing file:${input.fileContext}`
      : "",
    userNotesSection(input.userNotes),
    "",
    "Work completed since your last review (compact landed-change digest, not full file contents):",
    input.executedText,
    input.outstandingTasks?.trim()
      ? `\nRequired tasks still not done:\n${input.outstandingTasks}\nDo NOT set "done": true while any required task is listed here. Approve completed outstanding tasks, send unfinished ones back with precise fix instructions, or create replacement tasks that explicitly cover the missing work.`
      : "",
    "",
    scoreboardSection(input.scoreboard),
    "Review each task's output from the digest, automated build checks, and targeted reads/searches when needed. You can fix small problems YOURSELF before your decision — your changes overwrite the workers'. For bigger problems, send the task back with precise fix instructions.",
    EDIT_BLOCK_INSTRUCTION,
    input.readHopsLeft && input.readHopsLeft > 0
      ? `If you need to see an existing file's contents before deciding, respond with only JSON tool actions — e.g.\n{"action":"read","paths":["relative/path", "..."]}\n(max 8 paths; ${input.readHopsLeft} read request${input.readHopsLeft === 1 ? "" : "s"} left in this review). You may combine a few independent reads/searches in one turn. Never guess at a file's contents — read it.`
      : "",
    readRangeToolDoc(input.rangeReadsLeft),
    searchToolDoc(input.searchesLeft),
    runToolDoc(input.runsLeft, input.shellHint, input.githubWorkflow, input.repoWorkflow),
    fetchToolDoc(input.fetchesLeft),
    repoToolDoc(input.repoWorkflow, input.githubCli, input.githubWorkflow),
    mcpToolDoc(input.mcpToolsDoc, input.mcpCallsLeft),
    "",
    "End with ONE fenced json block:",
    "```json",
    `{"action":"review","results":[{"taskId":"T1","verdict":"approve" /* or "fix" */,"fixInstructions":"required when verdict is fix"}],"newTasks":[{"id":"T9","title":"...","instructions":"...","contextFiles":["existing files the worker must see"],"outputPaths":["every file this task may create or modify"],"dependsOn":[],"assignTo":"optional worker display name","difficulty":3}],"done":false,"notes":"updated conventions if any"}`,
    "```",
    `New tasks run CONCURRENTLY when their "dependsOn" tasks are finished — keep dependsOn empty unless a task consumes another task's output, and give each task exclusive ownership of its files via outputPaths. Always list the existing files a new task builds on in contextFiles.`,
    `Rules: max ${input.maxNewTasks} new tasks; ${input.cyclesLeft} review cycle${input.cyclesLeft === 1 ? "" : "s"} remain after this one, so prioritize what makes the project complete and working. Set "done": true ONLY when the project fulfils the request with no outstanding fixes.`,
    input.userNotes?.trim()
      ? 'The user\'s notes above are requirements: turn any that aren\'t covered yet into fix instructions or new tasks, and do NOT set "done": true while one remains unaddressed.'
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildArchitectSummaryPrompt(input: {
  request: string;
  treeText: string;
  /** Paths actually written this run — the summary may only claim these. */
  filesChanged?: string;
  historyText: string;
  verbosityInstruction?: string;
  userNotes?: string;
}): string {
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
    userNotesSection(input.userNotes),
    "",
    "Build history (plans, reviews, outcomes):",
    input.historyText,
    "",
    input.verbosityInstruction ?? "",
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

/**
 * Build the deterministic `## Repository workflow` summary block appended to the
 * Architect's final answer (NRW-006/008). Pure + bounded so the engine and the
 * test both render the exact same shape. Returns "" when there is nothing to
 * show (no branch, commits, issue, push, or PR). The optional verification line
 * states the resolved verify command's result when known.
 */
export function buildRepoWorkflowSummary(input: {
  branch?: string | null;
  commits?: Array<{ hash: string; subject: string }>;
  issueNumber?: number | null;
  issueNumbers?: number[];
  milestoneTitle?: string | null;
  pushedBranch?: string | null;
  prUrl?: string | null;
  verification?: string | null;
}): string {
  const commits = input.commits ?? [];
  const issueNumbers = [
    ...new Set(
      [
        ...(input.issueNumbers ?? []),
        ...(input.issueNumber != null ? [input.issueNumber] : []),
      ].filter((issue) => Number.isInteger(issue) && issue > 0)
    ),
  ];
  const hasAnything =
    !!input.branch ||
    commits.length > 0 ||
    issueNumbers.length > 0 ||
    !!input.milestoneTitle?.trim() ||
    !!input.pushedBranch ||
    !!input.prUrl ||
    !!input.verification?.trim();
  if (!hasAnything) return "";

  const lines = ["", "## Repository workflow", ""];
  if (input.branch) lines.push(`- Branch: \`${input.branch}\``);
  if (commits.length > 0) {
    for (const c of commits.slice(0, 20)) {
      lines.push(`- Commit \`${c.hash}\` ${c.subject}`);
    }
    if (commits.length > 20) {
      lines.push(`- …(+${commits.length - 20} more commit(s))`);
    }
  } else if (input.branch) {
    lines.push("- No commits were made this run.");
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
  return lines.join("\n");
}

