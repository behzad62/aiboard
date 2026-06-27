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
  const positiveScore =
    TOOL_RELIABILITY_WEIGHTS.schemaValidRate *
      clamp01(input.schemaValidRate) +
    TOOL_RELIABILITY_WEIGHTS.firstAttemptValidRate *
      clamp01(input.firstAttemptValidRate) +
    TOOL_RELIABILITY_WEIGHTS.repairSuccessRate *
      clamp01(input.repairSuccessRate) +
    TOOL_RELIABILITY_WEIGHTS.toolValidRate * clamp01(input.toolValidRate) +
    TOOL_RELIABILITY_WEIGHTS.patchSuccessRate * clamp01(input.patchSuccessRate) +
    TOOL_RELIABILITY_WEIGHTS.commandSafetyRate *
      clamp01(input.commandSafetyRate);

  return round(positiveScore * (1 - clamp01(input.forbiddenActionRate)) * 100);
}
