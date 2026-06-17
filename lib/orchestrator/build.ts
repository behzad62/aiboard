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
  /** Pinned worker index — fix tasks return to the model that did the work. */
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
    ? `Worker performance so far (the engine tracks this automatically from your approve/fix verdicts, failures, and output speed relative to the other workers — higher score = more reliable). Assign harder or foundational tasks to higher-scoring workers via each task's "assignTo" (worker display name); benched workers won't be given tasks:\n${scoreboard}`
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
  | RepoBranchCreateAction;

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
    action.action === "repo_branch_create"
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
    action.action === "repo_diff"
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

function looksLikeIncompleteToolAction(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!/"action"\s*:\s*"(?:read|read_range|search|patch|append|run|shell|tool|fetch|repo_status|repo_diff|repo_branch_create)"/i.test(trimmed)) {
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
      // redundant. repo_status/repo_diff intentionally fall through to null —
      // repo state legitimately changes between calls, so the Architect must be
      // able to re-query after writes (the loop caps bound runaway looping).
      return `repo_branch_create:${action.name.trim().toLowerCase()}`;
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

function githubWorkflowDoc(enabled?: boolean): string {
  if (!enabled) return "";
  return [
    "GITHUB WORKFLOW SKILL - the user asked you to handle GitHub issue-to-PR work for the provided repository.",
    "Assume `gh` is installed and authenticated. Use non-interactive `gh` and `git` commands through the runner.",
    "Issue selection: list open issues, prefer an issue whose title/body/comments contain `#aoboard` or `@aiboard`; if none exists, automatically choose the most actionable open issue.",
    "Before assigning worker tasks, create and switch to a feature branch for the chosen issue. Use a clear branch name that includes the issue number when available.",
    "Turn the selected issue into focused worker tasks, then review/fix/verify normally. At the end, commit the intended changes, push the feature branch, and create a PR that references the issue.",
    "There are no in-app approval gates for this workflow; human approval happens on GitHub when reviewing and merging the PR.",
    "GitHub workflow commands beginning with `gh` or `git` do not count against the normal command budget, but still run one command at a time and must be non-interactive.",
  ].join("\n");
}

function repoToolDoc(repoWorkflow?: boolean): string {
  if (!repoWorkflow) return "";
  return [
    "TOOL — repo (Git): the runner folder is a Git repository. Use these TYPED actions for repo operations instead of running raw `git` commands. Emit exactly one JSON action per turn and wait for the result before the next.",
    '- Status: {"action":"repo_status","reason":"why"} — current branch, dirty file counts, and ahead/behind. Non-mutating; re-query freely after writes.',
    '- Diff: {"action":"repo_diff","paths":["optional/scope"],"staged":false,"stat":false,"reason":"why"} — a bounded diff; "stat" gives a summary, "staged" diffs the index. Non-mutating.',
    '- Create branch: {"action":"repo_branch_create","name":"feature/topic","base":"main","checkout":true,"reason":"why"} — creates (and by default checks out) a branch. Branch names allow letters, digits, ".", "_", "/", "-" only. This MUTATES the repo, so it needs the user\'s approval; the user may deny it — respect that and continue.',
  ].join("\n");
}

function runToolDoc(
  runsLeft?: number,
  shellHint?: string,
  githubWorkflow?: boolean
): string {
  if ((!runsLeft || runsLeft <= 0) && !githubWorkflow) return "";
  return [
    "TOOL — run commands: the user granted you a local runner that executes shell commands in the project folder. Use it to install dependencies, run tests, build, or inspect the environment. To run a command, respond with ONLY:",
    '{"action":"run","command":"npm test","reason":"verify the suite passes"}',
    "Commands must NOT edit project files: do not use fs.writeFileSync, redirection, Set-Content, sed -i, rm/move/copy, or scripts that modify source files. Use patch/append/edit output for file changes, then run commands only to verify or inspect.",
    githubWorkflowDoc(githubWorkflow),
    runsLeft && runsLeft > 0
      ? `One non-interactive command at a time (no editors/watch modes/prompts); stdout, stderr, and the exit code come back to you. ${runsLeft} normal run${runsLeft === 1 ? "" : "s"} left in this phase. The user may deny a command — respect that and continue without it.`
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
  /** Hand-off summary from a previous pass — this is a follow-up build. */
  previousSummary?: string;
}): string {
  const readOption = input.readHopsLeft > 0
    ? `If you need to inspect existing files before planning, respond with ONLY:\n{"action":"read","paths":["relative/path", "..."]}\n(max 8 paths; you have ${input.readHopsLeft} read request${input.readHopsLeft === 1 ? "" : "s"} left). Otherwise, plan now.`
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
    runToolDoc(input.runsLeft, input.shellHint, input.githubWorkflow),
    fetchToolDoc(input.fetchesLeft),
    repoToolDoc(input.repoWorkflow),
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
      ? "STRICT TOOL CALL RULE: if you use a file tool, your entire response must be exactly ONE JSON object for ONE tool action. No prose before/after it. No multiple JSON actions. Do not claim what a tool returned until the next turn after the engine sends the tool result."
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
      ? `If you need to see an existing file's contents before deciding, respond with ONLY:\n{"action":"read","paths":["relative/path", "..."]}\n(max 8 paths; ${input.readHopsLeft} read request${input.readHopsLeft === 1 ? "" : "s"} left in this review). Never guess at a file's contents — read it.`
      : "",
    readRangeToolDoc(input.rangeReadsLeft),
    searchToolDoc(input.searchesLeft),
    runToolDoc(input.runsLeft, input.shellHint, input.githubWorkflow),
    fetchToolDoc(input.fetchesLeft),
    repoToolDoc(input.repoWorkflow),
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
