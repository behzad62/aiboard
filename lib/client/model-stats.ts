import type { ModelBuildStat } from "@/lib/db/schema";
import { resolveModelName } from "@/lib/client/providers";

/**
 * Pure metric helpers over {@link ModelBuildStat}. Shared by the benchmark
 * page (and anything else that surfaces Build-mode model performance). Three
 * honest axes are kept separate rather than collapsed into one number:
 *  - Quality: difficulty-weighted approvals/fixes/bad-output.
 *  - Speed: output throughput (chars/s) from successful responses only.
 *  - Reliability: provider availability (infra denials never touch quality —
 *    a free-tier 429 isn't the model's fault).
 */

/** Difficulty-weighted quality tally; unavailable never counts against it. */
export function qualityScore(s: ModelBuildStat): number {
  return s.wApprovals * 3 - s.wFixes - s.wBadOutput * 4;
}

/**
 * Quality normalized per decided attempt, so a high-volume model doesn't
 * dominate a sharper but less-used one. Denominator is attempts that the
 * provider actually answered (attempts minus unavailable); returns null when
 * there are no decided attempts.
 */
export function qualityPerAttempt(s: ModelBuildStat): number | null {
  const decided = s.attempts - s.unavailable;
  return decided > 0 ? qualityScore(s) / decided : null;
}

/** Share of decided attempts the Architect approved (unavailable excluded). */
export function approvalRate(s: ModelBuildStat): number | null {
  const decided = s.approvals + s.fixes + s.badOutput; // unavailable excluded
  return decided > 0 ? s.approvals / decided : null;
}

/** Share of attempts the provider was available for (1 - denial rate). */
export function availability(s: ModelBuildStat): number | null {
  return s.attempts > 0 ? 1 - s.unavailable / s.attempts : null;
}

/** Output throughput in chars/second, from successful responses only. */
export function charsPerSecond(s: ModelBuildStat): number | null {
  return s.responseMs > 0 && s.responseChars > 0
    ? (s.responseChars / s.responseMs) * 1000
    : null;
}

/** One judge's contribution to a model's verdicts, with a display name. */
export interface JudgeBreakdown {
  /** Full namespaced judge id (providerId:modelId). */
  id: string;
  /** Human-readable judge name. */
  name: string;
  /** Architect approve/fix verdicts this judge contributed. */
  verdicts: number;
}

/** Structured judge summary so the UI can render trust info richly. */
export interface JudgeSummary {
  /** Per-judge breakdown, descending by verdict count. */
  judges: JudgeBreakdown[];
  /** Total Architect approve/fix verdicts across all judges. */
  totalVerdicts: number;
  /**
   * Percent of verdicts made by a judge OTHER than this model itself (0–100),
   * or null when there are no verdicts. A low value means much of this model's
   * grade is self-graded — lower trust.
   */
  independentPct: number | null;
}

/**
 * Build a structured summary of who graded this model and how independent the
 * grading was, replacing the old prebuilt-string note so the page can render
 * it richly.
 */
export function judgeSummary(s: ModelBuildStat): JudgeSummary {
  const judges: JudgeBreakdown[] = Object.entries(s.judges)
    .map(([id, verdicts]) => ({ id, name: resolveModelName(id), verdicts }))
    .sort((a, b) => b.verdicts - a.verdicts);
  const totalVerdicts = judges.reduce((acc, j) => acc + j.verdicts, 0);
  return {
    judges,
    totalVerdicts,
    independentPct:
      totalVerdicts > 0
        ? Math.round((s.independentVerdicts / totalVerdicts) * 100)
        : null,
  };
}
