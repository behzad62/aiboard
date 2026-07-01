import type { FireworksGameMetrics, FireworksGameState } from "./types";
import { FIREWORKS_MAX_SCORE, scoreFireworksState } from "./engine";

export interface FireworksTeamScoreInput {
  metrics: FireworksGameMetrics;
  targetCostPerPoint?: number;
}

export interface FireworksMetricRates {
  legalActionRate: number;
  legalActionSampled: boolean;
  usefulClueRate: number;
  usefulClueSampled: boolean;
  safePlayRate: number;
  safePlaySampled: boolean;
  criticalDiscardSafety: number;
  criticalDiscardSampled: boolean;
  memoryConsistencyRate: number;
  memoryConsistencySampled: boolean;
  efficiencyFactor: number;
}

export function computeFireworksGameMetrics(input: {
  state: FireworksGameState;
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  durationMs?: number;
}): FireworksGameMetrics {
  const events = input.state.events;
  const finalScore = scoreFireworksState(input.state);
  const legalActions = events.filter((event) => event.legal).length;
  const illegalActions = events.filter((event) => !event.legal).length;
  const fallbackActions = events.filter((event) => event.fallbackUsed).length;
  const clueEvents = events.filter(
    (event) =>
      event.action.action === "clue_color" || event.action.action === "clue_rank"
  );
  const playEvents = events.filter((event) => event.action.action === "play");
  const discardEvents = events.filter((event) => event.action.action === "discard");
  const memoryConsistentActions = events.filter(
    (event) => event.memoryConsistent !== false
  ).length;
  const memoryInconsistentActions = events.filter(
    (event) => event.memoryConsistent === false
  ).length;

  return {
    scoreKind: "full_game",
    scenarioQualityScore: null,
    fullGameStackScore: finalScore,
    fullGameTeamScore: finalScore / FIREWORKS_MAX_SCORE,
    finalScore,
    maxScore: FIREWORKS_MAX_SCORE,
    normalizedScore: finalScore / FIREWORKS_MAX_SCORE,
    legalActions,
    illegalActions,
    fallbackActions,
    cluesGiven: clueEvents.length,
    usefulClues: clueEvents.filter((event) => event.useful).length,
    wastedClues: clueEvents.filter((event) => !event.useful).length,
    plays: playEvents.length,
    safePlays: playEvents.filter((event) => event.playResult === "success").length,
    badPlays: playEvents.filter((event) => event.playResult === "misplay").length,
    discards: discardEvents.length,
    safeDiscards: discardEvents.filter((event) => !event.criticalDiscard).length,
    criticalDiscards: discardEvents.filter((event) => event.criticalDiscard).length,
    memoryConsistentActions,
    memoryInconsistentActions,
    modelCalls: input.modelCalls ?? 0,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    costUsd: input.costUsd ?? null,
    durationMs: input.durationMs ?? 0,
  };
}

export function scoreFireworksTeamIq(input: FireworksTeamScoreInput): number {
  const metrics = input.metrics;
  if (
    metrics.modelCalls === 0 &&
    metrics.legalActions + metrics.illegalActions === 0
  ) {
    return 0;
  }
  const rates = computeFireworksMetricRates(input);

  return roundScore(
    100 *
      (0.4 * metrics.normalizedScore +
        0.15 * rates.legalActionRate +
        0.15 * rates.usefulClueRate +
        0.1 * rates.safePlayRate +
        0.1 * rates.criticalDiscardSafety +
        0.05 * rates.memoryConsistencyRate +
        0.05 * rates.efficiencyFactor)
  );
}

export function computeFireworksMetricRates(
  input: FireworksTeamScoreInput
): FireworksMetricRates {
  const metrics = input.metrics;
  const legalActionDenominator = metrics.legalActions + metrics.illegalActions;
  const memoryDenominator =
    metrics.memoryConsistentActions + metrics.memoryInconsistentActions;
  const actualCostPerPoint =
    metrics.costUsd !== null && metrics.finalScore !== null && metrics.finalScore > 0
      ? metrics.costUsd / metrics.finalScore
      : null;
  const efficiencyFactor =
    actualCostPerPoint && input.targetCostPerPoint
      ? Math.min(1, input.targetCostPerPoint / actualCostPerPoint)
      : 1;

  return {
    legalActionRate: rate(metrics.legalActions, legalActionDenominator, 0),
    legalActionSampled: legalActionDenominator > 0,
    usefulClueRate: rate(metrics.usefulClues, metrics.cluesGiven, 0),
    usefulClueSampled: metrics.cluesGiven > 0,
    safePlayRate: rate(metrics.safePlays, metrics.plays, 0),
    safePlaySampled: metrics.plays > 0,
    criticalDiscardSafety: 1 - rate(metrics.criticalDiscards, metrics.discards, 0),
    criticalDiscardSampled: metrics.discards > 0,
    memoryConsistencyRate: rate(
      metrics.memoryConsistentActions,
      memoryDenominator,
      1
    ),
    memoryConsistencySampled: memoryDenominator > 0,
    efficiencyFactor,
  };
}

function rate(
  numerator: number,
  denominator: number,
  unsampledDefault: number
): number {
  return denominator > 0 ? numerator / denominator : unsampledDefault;
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}
