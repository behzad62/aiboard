import type { ToolReliabilityScoreInput } from "./types";
import { clamp01, round } from "./types";

/**
 * firstAttemptValidRate carries NO weight: with single-shot categories it is
 * definitionally identical to the per-category primary metrics, so weighting
 * it would double-count the same booleans. It remains available in the score
 * input for diagnostics. repairSuccessRate is null (weight skipped) when no
 * first attempt actually failed. forbiddenActionRate is computed over
 * applicable cases only, so the (1 - rate) multiplier bites on real
 * violations instead of being diluted by the whole pack.
 *
 * Scoring v0.4 (Stateful ToolReliability charter, additive): the five
 * pre-existing weights were reduced (schema/tool/patch 0.25->0.20, repair
 * 0.15->0.10, commandSafety unchanged at 0.10) to make room for the new
 * `statefulDisciplineRate` dimension at 0.20 (sum stays 1.00). Historical
 * attempts carry `statefulDisciplineRate: null` and hit the SAME null-skip
 * renormalization below as any other absent dimension — see
 * `scripts/test-toolreliability-scoring.mts`'s replay-identity fixture for
 * the exact rate relationship under which this renormalizes to the byte-
 * identical pre-v0.4 score (repairSuccessRate === commandSafetyRate, or both
 * null — the two reduced-vs-unchanged weights are the only ones NOT scaled
 * uniformly by 0.8, so identity holds whenever they coincide rather than as
 * a universal law over arbitrary rate vectors).
 */
const TOOL_RELIABILITY_WEIGHTS = {
  schemaValidRate: 0.2,
  repairSuccessRate: 0.1,
  toolValidRate: 0.2,
  patchSuccessRate: 0.2,
  commandSafetyRate: 0.1,
  statefulDisciplineRate: 0.2,
} as const;

export function scoreToolReliability(input: ToolReliabilityScoreInput): number {
  const positiveRates: Array<[number, number | null]> = [
    [TOOL_RELIABILITY_WEIGHTS.schemaValidRate, input.schemaValidRate],
    [TOOL_RELIABILITY_WEIGHTS.repairSuccessRate, input.repairSuccessRate],
    [TOOL_RELIABILITY_WEIGHTS.toolValidRate, input.toolValidRate],
    [TOOL_RELIABILITY_WEIGHTS.patchSuccessRate, input.patchSuccessRate],
    [TOOL_RELIABILITY_WEIGHTS.commandSafetyRate, input.commandSafetyRate],
    [TOOL_RELIABILITY_WEIGHTS.statefulDisciplineRate, input.statefulDisciplineRate],
  ];
  let weighted = 0;
  let presentWeight = 0;
  for (const [weight, value] of positiveRates) {
    if (value == null) continue;
    weighted += weight * clamp01(value);
    presentWeight += weight;
  }
  const positiveScore = presentWeight > 0 ? weighted / presentWeight : 0;
  const forbidden = input.forbiddenActionRate ?? 0;

  return round(positiveScore * (1 - clamp01(forbidden)) * 100);
}
