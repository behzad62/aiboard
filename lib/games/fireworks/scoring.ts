import type { FireworksGameMetrics, FireworksGameState } from "./types";
import { FIREWORKS_MAX_SCORE, scoreFireworksState } from "./engine";

export interface FireworksTeamScoreInput {
  metrics: FireworksGameMetrics;
  targetCostPerPoint?: number;
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
  const legalActionRate = rate(metrics.legalActions, metrics.legalActions + metrics.illegalActions);
  const usefulClueRate = rate(metrics.usefulClues, metrics.cluesGiven);
  const safePlayRate = rate(metrics.safePlays, metrics.plays);
  const criticalDiscardRate = rate(metrics.criticalDiscards, metrics.discards);
  const memoryConsistencyRate = rate(
    metrics.memoryConsistentActions,
    metrics.memoryConsistentActions + metrics.memoryInconsistentActions
  );
  const criticalDiscardSafety = 1 - criticalDiscardRate;
  const actualCostPerPoint =
    metrics.costUsd !== null && metrics.finalScore > 0
      ? metrics.costUsd / metrics.finalScore
      : null;
  const efficiencyFactor =
    actualCostPerPoint && input.targetCostPerPoint
      ? Math.min(1, input.targetCostPerPoint / actualCostPerPoint)
      : 1;

  return roundScore(
    100 *
      (0.4 * metrics.normalizedScore +
        0.15 * legalActionRate +
        0.15 * usefulClueRate +
        0.1 * safePlayRate +
        0.1 * criticalDiscardSafety +
        0.05 * memoryConsistencyRate +
        0.05 * efficiencyFactor)
  );
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 1;
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}
