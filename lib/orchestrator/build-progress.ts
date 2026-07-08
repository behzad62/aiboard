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
