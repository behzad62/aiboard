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

/**
 * Total worker tokens (input + output) spent per Architect-approved task — the
 * regression metric for token efficiency. Lower is better; a model that burns
 * tokens on tasks that fail or need fixing scores worse because that waste is
 * folded into the numerator (see {@link ModelBuildStat.inputTokens}). Returns
 * null when the model has no approvals yet (nothing to amortize against).
 */
export function tokensPerApproval(stats: {
  inputTokens: number;
  outputTokens: number;
  approvals: number;
}): number | null {
  return stats.approvals > 0
    ? Math.round((stats.inputTokens + stats.outputTokens) / stats.approvals)
    : null;
}

/**
 * One build's per-worker contribution to a model's global stats. Everything the
 * accumulator needs from a run; the persisted-only fields (`builds`, `judges`,
 * `independentVerdicts`, `updatedAt`) are derived when folding, not supplied.
 */
export type ModelStatDelta = Omit<
  ModelBuildStat,
  "builds" | "judges" | "independentVerdicts" | "updatedAt"
>;

/**
 * Fill any {@link ModelBuildStat} field absent from a record persisted before
 * that field existed. The single source of truth for legacy normalization,
 * shared by the store's read/accumulate paths and the pure fold below — new
 * numeric fields (e.g. token totals) default to 0 so old records never NaN a
 * running sum.
 */
export function normalizeModelStat(
  m: Partial<ModelBuildStat> & { modelId: string }
): ModelBuildStat {
  return {
    modelId: m.modelId,
    displayName: m.displayName ?? m.modelId,
    builds: m.builds ?? 0,
    attempts: m.attempts ?? 0,
    approvals: m.approvals ?? 0,
    fixes: m.fixes ?? 0,
    badOutput: m.badOutput ?? 0,
    unavailable: m.unavailable ?? 0,
    wApprovals: m.wApprovals ?? 0,
    wFixes: m.wFixes ?? 0,
    wBadOutput: m.wBadOutput ?? 0,
    responseMs: m.responseMs ?? 0,
    responseChars: m.responseChars ?? 0,
    inputTokens: m.inputTokens ?? 0,
    outputTokens: m.outputTokens ?? 0,
    judges: { ...(m.judges ?? {}) },
    independentVerdicts: m.independentVerdicts ?? 0,
    updatedAt: m.updatedAt ?? new Date(0).toISOString(),
  };
}

/**
 * Pure fold of one build's per-worker delta into a model's running record —
 * the store-free core of `accumulateModelStats`, so the arithmetic is testable
 * without the client store. Pass the model's existing record (or undefined for
 * a first-ever build) and get back the merged record; the store just persists
 * the result. `now` is the timestamp to stamp on the merged record so callers
 * control the clock. Token totals sum across builds and include every worker
 * call on the task, approved or not — that waste is the KPI's whole point.
 */
export function mergeModelStatsRecord(
  existing: (Partial<ModelBuildStat> & { modelId: string }) | undefined,
  incoming: ModelStatDelta,
  judgeModelId: string,
  now: string
): ModelBuildStat {
  // Only Architect approve/fix verdicts count as judge verdicts; engine-detected
  // bad output and provider denials were never graded by anyone.
  const verdicts = incoming.approvals + incoming.fixes;
  const independent = judgeModelId !== incoming.modelId ? verdicts : 0;
  if (!existing) {
    return {
      ...incoming,
      builds: 1,
      judges: verdicts > 0 ? { [judgeModelId]: verdicts } : {},
      independentVerdicts: independent,
      updatedAt: now,
    };
  }
  // Coalesce against records persisted before newer fields existed.
  const merged = normalizeModelStat(existing);
  merged.displayName = incoming.displayName;
  merged.builds += 1;
  merged.attempts += incoming.attempts;
  merged.approvals += incoming.approvals;
  merged.fixes += incoming.fixes;
  merged.badOutput += incoming.badOutput;
  merged.unavailable += incoming.unavailable;
  merged.wApprovals += incoming.wApprovals;
  merged.wFixes += incoming.wFixes;
  merged.wBadOutput += incoming.wBadOutput;
  merged.responseMs += incoming.responseMs;
  merged.responseChars += incoming.responseChars;
  merged.inputTokens += incoming.inputTokens;
  merged.outputTokens += incoming.outputTokens;
  // Don't list a judge that contributed no verdicts (e.g. all attempts were
  // provider denials) — it never actually graded this model.
  if (verdicts > 0) {
    merged.judges[judgeModelId] = (merged.judges[judgeModelId] ?? 0) + verdicts;
  }
  merged.independentVerdicts += independent;
  merged.updatedAt = now;
  return merged;
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
