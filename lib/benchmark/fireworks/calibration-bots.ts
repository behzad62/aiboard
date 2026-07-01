import {
  applyFireworksAction,
  createFireworksGame,
  fireworksActionsEqual,
  getLegalFireworksActions,
  isPlayableCard,
} from "@/lib/games/fireworks/engine";
import {
  chooseDeterministicFireworksFallback,
} from "@/lib/games/fireworks/ai";
import {
  computeFireworksGameMetrics,
  scoreFireworksTeamIq,
} from "@/lib/games/fireworks/scoring";
import type {
  FireworksAction,
  FireworksGameMetrics,
  FireworksGameState,
} from "@/lib/games/fireworks/types";
import type { FireworksFullGameCase } from "./types";

export type FireworksCalibrationBotId =
  | "random_legal"
  | "always_discard"
  | "safe_clue"
  | "greedy_playable"
  | "forgetful";

export interface FireworksCalibrationBot {
  id: FireworksCalibrationBotId;
  label: string;
  chooseAction: (state: FireworksGameState, playerId: string) => FireworksAction;
}

export interface FireworksCalibrationResult {
  botId: FireworksCalibrationBotId;
  label: string;
  caseCount: number;
  averageScore: number;
  averageStackScore: number;
  averageBadPlays: number;
  averageCriticalDiscards: number;
  averageUsefulClueRate: number;
}

export const FIREWORKS_CALIBRATION_BOTS: FireworksCalibrationBot[] = [
  {
    id: "random_legal",
    label: "Random legal",
    chooseAction: chooseRandomLegal,
  },
  {
    id: "always_discard",
    label: "Always discard",
    chooseAction: chooseAlwaysDiscard,
  },
  {
    id: "safe_clue",
    label: "Safe clue",
    chooseAction: chooseSafeClue,
  },
  {
    id: "greedy_playable",
    label: "Greedy playable",
    chooseAction: chooseGreedyPlayable,
  },
  {
    id: "forgetful",
    label: "Forgetful",
    chooseAction: chooseForgetful,
  },
];

export function runFireworksCalibrationBots(input: {
  cases: FireworksFullGameCase[];
  playerCount: 2 | 3;
  maxTurns?: number;
}): FireworksCalibrationResult[] {
  return FIREWORKS_CALIBRATION_BOTS.map((bot) => {
    const metrics = input.cases.map((benchmarkCase) =>
      runCalibrationCase({
        bot,
        benchmarkCase,
        playerCount: input.playerCount,
        maxTurns: input.maxTurns ?? benchmarkCase.maxTurns,
      })
    );
    return {
      botId: bot.id,
      label: bot.label,
      caseCount: metrics.length,
      averageScore: round(average(metrics.map((item) => scoreFireworksTeamIq({ metrics: item })))),
      averageStackScore: round(average(metrics.map((item) => item.finalScore ?? 0))),
      averageBadPlays: round(average(metrics.map((item) => item.badPlays))),
      averageCriticalDiscards: round(
        average(metrics.map((item) => item.criticalDiscards))
      ),
      averageUsefulClueRate: round(
        average(
          metrics.map((item) =>
            item.cluesGiven > 0 ? item.usefulClues / item.cluesGiven : 0
          )
        )
      ),
    };
  });
}

function runCalibrationCase(input: {
  bot: FireworksCalibrationBot;
  benchmarkCase: FireworksFullGameCase;
  playerCount: 2 | 3;
  maxTurns: number;
}): FireworksGameMetrics {
  let state = createFireworksGame({
    seed: input.benchmarkCase.seed,
    playerCount: input.playerCount,
    clueTokens: input.benchmarkCase.clueTokens,
    mistakeTokens: input.benchmarkCase.mistakeTokens,
    players: Array.from({ length: input.playerCount }, (_, index) => ({
      id: `P${index + 1}`,
      label: `Player P${index + 1}`,
      kind: "ai" as const,
    })),
  });

  while (state.status === "playing" && state.turn < input.maxTurns) {
    const playerId = state.players[state.currentPlayerIndex]?.id ?? "P1";
    const action = input.bot.chooseAction(state, playerId);
    state = applyFireworksAction(state, playerId, action);
  }

  return computeFireworksGameMetrics({ state });
}

function chooseRandomLegal(
  state: FireworksGameState,
  playerId: string
): FireworksAction {
  const legal = getLegalFireworksActions(state, playerId);
  return legal[hashIndex(`${state.seed}:${state.turn}:${playerId}`, legal.length)] ??
    chooseDeterministicFireworksFallback(state, playerId);
}

function chooseAlwaysDiscard(
  state: FireworksGameState,
  playerId: string
): FireworksAction {
  return (
    getLegalFireworksActions(state, playerId).find(
      (action) => action.action === "discard"
    ) ?? chooseDeterministicFireworksFallback(state, playerId)
  );
}

function chooseSafeClue(
  state: FireworksGameState,
  playerId: string
): FireworksAction {
  return (
    visiblePlayableClue(state, playerId) ??
    safeDiscard(state, playerId) ??
    chooseDeterministicFireworksFallback(state, playerId)
  );
}

function chooseGreedyPlayable(
  state: FireworksGameState,
  playerId: string
): FireworksAction {
  return (
    knownPlayableAction(state, playerId) ??
    visiblePlayableClue(state, playerId) ??
    safeDiscard(state, playerId) ??
    chooseDeterministicFireworksFallback(state, playerId)
  );
}

function chooseForgetful(
  state: FireworksGameState,
  playerId: string
): FireworksAction {
  return (
    getLegalFireworksActions(state, playerId).find(
      (action) => action.action === "play"
    ) ?? chooseAlwaysDiscard(state, playerId)
  );
}

function knownPlayableAction(
  state: FireworksGameState,
  playerId: string
): FireworksAction | null {
  const hand = state.hands.find((candidate) => candidate.playerId === playerId);
  if (!hand) return null;
  for (let index = 0; index < hand.knowledge.length; index++) {
    const knowledge = hand.knowledge[index];
    if (
      knowledge.color &&
      knowledge.rank &&
      isPlayableCard(state, {
        id: "known",
        color: knowledge.color,
        rank: knowledge.rank,
      })
    ) {
      const action: FireworksAction = { action: "play", cardIndex: index };
      if (isLegal(state, playerId, action)) return action;
    }
  }
  return null;
}

function visiblePlayableClue(
  state: FireworksGameState,
  playerId: string
): FireworksAction | null {
  const legal = getLegalFireworksActions(state, playerId);
  return (
    legal.find((action) => {
      if (action.action !== "clue_color" && action.action !== "clue_rank") {
        return false;
      }
      const hand = state.hands.find(
        (candidate) => candidate.playerId === action.targetPlayerId
      );
      if (!hand) return false;
      return hand.cards.some((card) => {
        const matches =
          action.action === "clue_color"
            ? card.color === action.color
            : card.rank === action.rank;
        return matches && isPlayableCard(state, card);
      });
    }) ?? null
  );
}

function safeDiscard(
  state: FireworksGameState,
  playerId: string
): FireworksAction | null {
  const hand = state.hands.find((candidate) => candidate.playerId === playerId);
  if (!hand) return null;
  for (let index = 0; index < hand.cards.length; index++) {
    const card = hand.cards[index];
    if (state.stacks[card.color] >= card.rank) {
      const action: FireworksAction = { action: "discard", cardIndex: index };
      if (isLegal(state, playerId, action)) return action;
    }
  }
  return null;
}

function isLegal(
  state: FireworksGameState,
  playerId: string,
  action: FireworksAction
): boolean {
  return getLegalFireworksActions(state, playerId).some((candidate) =>
    fireworksActionsEqual(candidate, action)
  );
}

function hashIndex(value: string, modulo: number): number {
  if (modulo <= 0) return 0;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % modulo;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
