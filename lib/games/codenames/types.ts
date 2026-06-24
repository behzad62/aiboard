import type { GameAIInteraction } from "../core/types";

export type CodenamesTeam = "red" | "blue";
export type CodenamesCardRole = CodenamesTeam | "neutral" | "assassin";
export type CodenamesPlayerRole = "spymaster" | "operative";
export type CodenamesGameMode = "pvp" | "pvai" | "aivai";
export type CodenamesPhase = "clue" | "guess" | "finished";
export type CodenamesStatus = "playing" | "paused" | "win";

export interface CodenamesCard {
  id: string;
  position?: string;
  word: string;
  role: CodenamesCardRole;
  revealed: boolean;
}

export interface CodenamesPublicCard {
  id: string;
  position: string;
  word: string;
  role: CodenamesCardRole | null;
  revealed: boolean;
}

export interface CodenamesClue {
  word: string;
  count: number;
}

export type CodenamesClueValidation =
  | { ok: true; clue: CodenamesClue }
  | { ok: false; error: string };

export type CodenamesGuessResult =
  | "own"
  | "opponent"
  | "neutral"
  | "assassin";

export interface CodenamesClueMoveRecord {
  type: "clue";
  team: CodenamesTeam;
  clue: CodenamesClue;
  timestamp: number;
  aiInteraction?: GameAIInteraction;
}

export interface CodenamesGuessMoveRecord {
  type: "guess";
  team: CodenamesTeam;
  cardId: string;
  word: string;
  role: CodenamesCardRole;
  result: CodenamesGuessResult;
  timestamp: number;
  aiInteraction?: GameAIInteraction;
}

export interface CodenamesEndTurnMoveRecord {
  type: "end-turn";
  team: CodenamesTeam;
  timestamp: number;
}

export type CodenamesMoveRecord =
  | CodenamesClueMoveRecord
  | CodenamesGuessMoveRecord
  | CodenamesEndTurnMoveRecord;

export interface CodenamesGameState {
  cards: CodenamesCard[];
  startingTeam: CodenamesTeam;
  turnTeam: CodenamesTeam;
  phase: CodenamesPhase;
  status: CodenamesStatus;
  winner: CodenamesTeam | null;
  activeClue: CodenamesClue | null;
  guessesRemaining: number;
  guessesMadeForActiveClue: number;
  moveHistory: CodenamesMoveRecord[];
}

export interface CodenamesAIConfig {
  modelId: string;
  reasoningEffort: string;
}

export interface CodenamesSpymasterAIResponse {
  clue: CodenamesClue;
  intendedWords?: string[];
  riskNotes?: string;
  gesture?: GameAIInteraction["gesture"];
  utterance?: string;
  confidence?: number;
  diagnostics?: string;
}

export interface CodenamesGuesserAIResponse {
  cardIds: string[];
  guesses: string[];
  rationale?: string;
  gesture?: GameAIInteraction["gesture"];
  utterance?: string;
  confidence?: number;
  diagnostics?: string;
}
