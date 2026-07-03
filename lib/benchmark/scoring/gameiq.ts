import type { GameIqScoreInput } from "./types";
import { clamp01, round } from "./types";

const GAME_IQ_WEIGHTS = {
  outcomeScore: 0.6,
  moveQuality: 0.4,
  // Legality and structured output are pass/fail gates (statusFromScore →
  // failed_tool_use), not score components: a model must not harvest 31 free
  // points for emitting valid JSON.
  legalActionRate: 0,
  structuredReliability: 0,
} as const;

export function scoreGameIqAttempt(input: GameIqScoreInput): number {
  const score =
    GAME_IQ_WEIGHTS.outcomeScore * clamp01(input.outcomeScore) +
    GAME_IQ_WEIGHTS.moveQuality * clamp01(input.moveQuality) +
    GAME_IQ_WEIGHTS.legalActionRate * clamp01(input.legalActionRate) +
    GAME_IQ_WEIGHTS.structuredReliability *
      clamp01(input.structuredReliability);

  return round(score * (1 - 0.5 * clamp01(input.fallbackRate)) * 100);
}
