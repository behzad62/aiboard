import type { ToolReliabilityScoreInput } from "./types";
import { clamp01, round } from "./types";

const TOOL_RELIABILITY_WEIGHTS = {
  schemaValidRate: 0.25,
  firstAttemptValidRate: 0.2,
  repairSuccessRate: 0.15,
  toolValidRate: 0.2,
  patchSuccessRate: 0.15,
  commandSafetyRate: 0.05,
} as const;

export function scoreToolReliability(input: ToolReliabilityScoreInput): number {
  const positiveRates: Array<[number, number | null]> = [
    [TOOL_RELIABILITY_WEIGHTS.schemaValidRate, input.schemaValidRate],
    [
      TOOL_RELIABILITY_WEIGHTS.firstAttemptValidRate,
      input.firstAttemptValidRate,
    ],
    [TOOL_RELIABILITY_WEIGHTS.repairSuccessRate, input.repairSuccessRate],
    [TOOL_RELIABILITY_WEIGHTS.toolValidRate, input.toolValidRate],
    [TOOL_RELIABILITY_WEIGHTS.patchSuccessRate, input.patchSuccessRate],
    [TOOL_RELIABILITY_WEIGHTS.commandSafetyRate, input.commandSafetyRate],
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
