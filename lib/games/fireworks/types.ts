import type { StructuredOutputFormat } from "@/lib/providers/base";

export type FireworksColor = "red" | "blue" | "green";
export type FireworksRank = 1 | 2 | 3 | 4 | 5;

export interface FireworksCard {
  id: string;
  color: FireworksColor;
  rank: FireworksRank;
}

export interface FireworksCardKnowledge {
  color?: FireworksColor;
  rank?: FireworksRank;
  notColors: FireworksColor[];
  notRanks: FireworksRank[];
  clueHistory: string[];
}

export interface FireworksPlayer {
  id: string;
  label: string;
  kind: "human" | "ai";
  modelId?: string;
}

export interface FireworksPlayerHand {
  playerId: string;
  cards: FireworksCard[];
  knowledge: FireworksCardKnowledge[];
}

export interface FireworksStackState {
  red: number;
  blue: number;
  green: number;
}

export interface FireworksDiscardedCard {
  card: FireworksCard;
  reason: "discarded" | "misplayed";
  playerId: string;
  turn: number;
  critical?: boolean;
}

export type FireworksAction =
  | {
      action: "clue_color";
      targetPlayerId: string;
      color: FireworksColor;
    }
  | {
      action: "clue_rank";
      targetPlayerId: string;
      rank: FireworksRank;
    }
  | {
      action: "play";
      cardIndex: number;
    }
  | {
      action: "discard";
      cardIndex: number;
    };

export interface FireworksEvent {
  id: string;
  turn: number;
  playerId: string;
  action: FireworksAction;
  legal: boolean;
  useful?: boolean;
  fallbackUsed?: boolean;
  memoryConsistent?: boolean;
  playResult?: "success" | "misplay";
  criticalDiscard?: boolean;
  message: string;
  resultingScore: number;
}

export interface FireworksGameState {
  id: string;
  seed: string;
  players: FireworksPlayer[];
  hands: FireworksPlayerHand[];
  deck: FireworksCard[];
  stacks: FireworksStackState;
  discardPile: FireworksDiscardedCard[];
  clueTokens: number;
  maxClueTokens: number;
  mistakeTokens: number;
  maxMistakeTokens: number;
  currentPlayerIndex: number;
  turn: number;
  status: "playing" | "completed" | "failed";
  events: FireworksEvent[];
}

export interface FireworksVisibleCard {
  id: string | null;
  color: FireworksColor | null;
  rank: FireworksRank | null;
  knowledge?: FireworksCardKnowledge;
}

export interface FireworksVisibleHand {
  playerId: string;
  label: string;
  cards: FireworksVisibleCard[];
}

export interface FireworksPlayerView {
  gameId: string;
  seed: string;
  playerId: string;
  playerLabel: string;
  currentPlayerId: string;
  ownHand: {
    playerId: string;
    count: number;
    cards: FireworksVisibleCard[];
    knowledge: FireworksCardKnowledge[];
  };
  otherHands: FireworksVisibleHand[];
  stacks: FireworksStackState;
  discardPile: FireworksDiscardedCard[];
  clueTokens: number;
  maxClueTokens: number;
  mistakeTokens: number;
  maxMistakeTokens: number;
  turn: number;
  status: FireworksGameState["status"];
  deckCount: number;
  events: FireworksEvent[];
  legalActions: FireworksAction[];
  recommendations: {
    knownPlayableCards: number[];
    visiblePlayableClues: FireworksAction[];
    safeDiscards: number[];
  };
}

export interface FireworksAiActionResult {
  action: FireworksAction | null;
  rawResponse: string;
  parsedResponseJson?: string;
  legal: boolean;
  fallbackUsed: boolean;
  latencyMs: number;
  traceId?: string;
  error?: string;
}

export interface FireworksGameMetrics {
  scoreKind: "scenario" | "full_game" | "mixed";
  scenarioQualityScore: number | null;
  fullGameStackScore: number | null;
  fullGameTeamScore: number | null;
  finalScore: number;
  maxScore: number;
  normalizedScore: number;
  legalActions: number;
  illegalActions: number;
  fallbackActions: number;
  cluesGiven: number;
  usefulClues: number;
  wastedClues: number;
  plays: number;
  safePlays: number;
  badPlays: number;
  discards: number;
  safeDiscards: number;
  criticalDiscards: number;
  memoryConsistentActions: number;
  memoryInconsistentActions: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
}

export interface FireworksActionSchema {
  format: StructuredOutputFormat;
}
