/**
 * Pure helpers for Build-mode failure fingerprinting and no-progress detection.
 * The engine uses these to distinguish recoverable failed attempts (which should
 * be retried) from genuine no-progress loops (which should stop as blocked), so a
 * build only gives up after repeated recovery attempts truly stall.
 */

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

export function shouldStopForNoProgress(input: {
  repeatedFailureCount: number;
  noProgressWaves: number;
}): boolean {
  return input.repeatedFailureCount >= 3 || input.noProgressWaves >= 4;
}
