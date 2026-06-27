import type { GameIqScoreInput } from "./types";
import { clamp01, round } from "./types";

const GAME_IQ_WEIGHTS = {
  outcomeScore: 0.35,
  moveQuality: 0.3,
  legalActionRate: 0.2,
  structuredReliability: 0.1,
  latencyFactor: 0.05,
} as const;

export function scoreGameIqAttempt(input: GameIqScoreInput): number {
  const score =
    GAME_IQ_WEIGHTS.outcomeScore * clamp01(input.outcomeScore) +
    GAME_IQ_WEIGHTS.moveQuality * clamp01(input.moveQuality) +
    GAME_IQ_WEIGHTS.legalActionRate * clamp01(input.legalActionRate) +
    GAME_IQ_WEIGHTS.structuredReliability *
      clamp01(input.structuredReliability) +
    GAME_IQ_WEIGHTS.latencyFactor * clamp01(input.latencyFactor);

  return round(score * (1 - 0.5 * clamp01(input.fallbackRate)) * 100);
}
