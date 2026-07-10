/**
 * Pure helpers for Build-mode failure fingerprinting and no-progress detection.
 * The engine uses these to distinguish recoverable failed attempts (which should
 * be retried) from genuine no-progress loops (which should stop as blocked), so a
 * build only gives up after repeated recovery attempts truly stall.
 */

import {
  nextIncrementalBuildTaskId,
  type BuildTask,
} from "./build";

export interface BuildProgressSignals {
  filesWritten: number;
  tasksAdvanced: number;
  failureChanged: boolean;
  repoAdvanced: boolean;
}

/**
 * Collapse a build/test failure into a stable fingerprint so the same underlying
 * error recurs to the same key even when line/column numbers move. Keyed by the
 * command plus the error code (TSxxxx / ERR_* / `Error: ...`) when one is present,
 * otherwise a normalized prefix of the output.
 */
export function fingerprintBuildFailure(command: string, output: string): string {
  const normalizedOutput = output
    .replace(/\b\d+:\d+\b/g, "line:col")
    .replace(/\(\d+,\d+\)/g, "(line,col)")
    .replace(/\bline\s+\d+\b/gi, "line n")
    .replace(/\s+/g, " ")
    .trim();
  const code =
    /\b(TS\d+|ERR_[A-Z0-9_]+|Error:\s*[^.]+)/.exec(normalizedOutput)?.[1] ??
    normalizedOutput.slice(0, 160);
  return `${command.trim()}|${code}`;
}

export function recordBuildFailure(
  counts: Record<string, number>,
  fingerprint: string
): Record<string, number> {
  return { ...counts, [fingerprint]: (counts[fingerprint] ?? 0) + 1 };
}

export function hasMeaningfulBuildProgress(signals: BuildProgressSignals): boolean {
  return (
    signals.filesWritten > 0 ||
    signals.tasksAdvanced > 0 ||
    signals.failureChanged ||
    signals.repoAdvanced
  );
}

export function countTaskStatusTransitions(
  previousStatuses: Map<string, BuildTask["status"]>,
  currentTasks: Array<Pick<BuildTask, "id" | "status">>
): number {
  return currentTasks.reduce((count, task) => {
    const previous = previousStatuses.get(task.id);
    if (!previous) return count + 1;
    return previous === task.status ? count : count + 1;
  }, 0);
}

export function shouldStopForNoProgress(input: {
  repeatedFailureCount: number;
  noProgressWaves: number;
}): boolean {
  return input.repeatedFailureCount >= 3 || input.noProgressWaves >= 4;
}

export function shouldRefreshLiveCheckpoint(input: {
  hasTasks: boolean;
  lastSavedAtMs: number;
  nowMs: number;
  minIntervalMs: number;
  force?: boolean;
}): boolean {
  if (!input.hasTasks) return false;
  if (input.force) return true;
  if (input.lastSavedAtMs <= 0) return true;
  const interval = Math.max(0, input.minIntervalMs);
  return input.nowMs - input.lastSavedAtMs >= interval;
}

export interface BuildEvidenceLedgerEntry {
  at: string;
  actor: string;
  label: string;
  summary: string;
  /** Task-scoped engine fact. Legacy Architect entries may omit this. */
  taskId?: string;
  /** Who produced the fact; this is provenance, not a verdict. */
  source?: "worker" | "architect" | "reviewer" | "engine";
  /** Typed operation that actually ran. */
  action?: string;
  /** Transport outcome only; semantic sufficiency belongs to the Architect. */
  status?: "succeeded" | "failed" | "skipped";
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateEvidence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 15)).trimEnd()} [truncated]`;
}

export function appendBuildEvidenceLedgerEntry(
  entries: BuildEvidenceLedgerEntry[],
  entry: BuildEvidenceLedgerEntry,
  maxEntries = 96
): BuildEvidenceLedgerEntry[] {
  const normalized: BuildEvidenceLedgerEntry = {
    at: entry.at,
    actor: compactWhitespace(entry.actor).slice(0, 80) || "unknown",
    label: compactWhitespace(entry.label).slice(0, 180) || "tool result",
    summary: truncateEvidence(compactWhitespace(entry.summary), 700),
    taskId: entry.taskId?.trim().slice(0, 80) || undefined,
    source: entry.source,
    action: entry.action?.trim().slice(0, 120) || undefined,
    status: entry.status,
  };
  const next = [...entries, normalized];
  return next.slice(-Math.max(1, maxEntries));
}

export function renderBuildEvidenceLedger(
  entries: BuildEvidenceLedgerEntry[],
  maxEntries = 8,
  taskIds?: string[]
): string {
  const taskIdSet = taskIds?.length ? new Set(taskIds) : null;
  const visible = entries
    .filter((entry) => !taskIdSet || (!!entry.taskId && taskIdSet.has(entry.taskId)))
    .slice(-Math.max(1, maxEntries));
  if (visible.length === 0) return "";
  return [
    "Engine-recorded tool facts already available (the Architect decides what they prove):",
    ...visible.map(
      (entry) => {
        const scope = entry.taskId ? ` | ${entry.taskId}` : "";
        const operation = entry.action ? ` | ${entry.action}` : "";
        const outcome = entry.status ? ` | ${entry.status}` : "";
        return `- ${entry.at}${scope} | ${entry.actor}${operation}${outcome} | ${entry.label}: ${entry.summary}`;
      }
    ),
    "Treat these as execution facts, not an engine verdict. Use them before rerunning checks; the Architect alone decides whether they satisfy the task.",
  ].join("\n");
}

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

export function extractVerificationFailurePaths(
  output: string,
  knownFiles: string[]
): string[] {
  const haystack = normalizePathForMatch(output);
  const seen = new Set<string>();
  const matches: string[] = [];
  const candidates = knownFiles
    .map((path) => ({ original: path, normalized: normalizePathForMatch(path) }))
    .filter(({ normalized }) => normalized.length > 0)
    .sort((a, b) => b.normalized.length - a.normalized.length);

  for (const candidate of candidates) {
    if (!haystack.includes(candidate.normalized)) continue;
    const key = candidate.normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(candidate.original);
  }

  return matches;
}

function taskOwnsPath(task: BuildTask, path: string): boolean {
  const target = normalizePathForMatch(path);
  return (task.outputPaths ?? []).some(
    (outputPath) => normalizePathForMatch(outputPath) === target
  );
}

function truncateForTask(text: string, max = 1400): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}

export function buildVerificationFailureTask(input: {
  tasks: BuildTask[];
  verifyCommand: string;
  verifyFeedback: string;
  knownFiles: string[];
  maxFiles?: number;
}): BuildTask | null {
  const paths = extractVerificationFailurePaths(
    input.verifyFeedback,
    input.knownFiles
  ).slice(0, input.maxFiles ?? 4);
  if (paths.length === 0) return null;
  const hasIncompleteOwner = input.tasks.some(
    (task) => task.status !== "done" && paths.some((path) => taskOwnsPath(task, path))
  );
  if (hasIncompleteOwner) return null;

  const id = nextIncrementalBuildTaskId(input.tasks);
  const pathList = paths.join(", ");
  return {
    id,
    title: `Fix failing verification for ${paths[0]}`,
    instructions: [
      `The automated verification command is failing: ${input.verifyCommand}.`,
      `Repair only the failing verification path(s): ${pathList}.`,
      "Use the failure output below as the reproduction, make the smallest targeted correction, then rerun the verification command.",
      "Include Skill evidence with RED test/check failure before implementation, root cause or reproduction identified before the fix, and GREEN test/check pass after implementation.",
      "Failure output:",
      "```",
      truncateForTask(input.verifyFeedback),
      "```",
    ].join("\n"),
    contextFiles: paths,
    outputPaths: paths,
    expectedOutputs: `Targeted fix for ${pathList} so ${input.verifyCommand} passes.`,
    dependsOn: [],
    difficulty: 3,
    status: "planned",
  };
}
