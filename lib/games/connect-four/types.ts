import type { GameAIInteraction } from "../core/types";

export type ConnectFourPlayer = "red" | "yellow";
export type ConnectFourCell = ConnectFourPlayer | null;
export type ConnectFourBoard = ConnectFourCell[][];
export type ConnectFourStatus = "playing" | "paused" | "win" | "draw";
export type ConnectFourGameMode = "pvp" | "pvai" | "aivai";

export interface ConnectFourMove {
  column: number;
}

export interface ConnectFourMoveRecord {
  move: ConnectFourMove;
  player: ConnectFourPlayer;
  displayColumn: number;
  boardAfter: ConnectFourBoard;
  timestamp: number;
  aiInteraction?: GameAIInteraction;
}

export interface ConnectFourClockState {
  redElapsedMs: number;
  yellowElapsedMs: number;
  turnStartedAt: number | null;
}

export interface ConnectFourGameState {
  board: ConnectFourBoard;
  turn: ConnectFourPlayer;
  status: ConnectFourStatus;
  winner: ConnectFourPlayer | null;
  moveHistory: ConnectFourMoveRecord[];
  clock: ConnectFourClockState;
}

export interface ConnectFourAIResponse {
  column: number;
  reasoning?: string;
  gesture?: GameAIInteraction["gesture"];
  utterance?: string;
  confidence?: number;
  diagnostics?: string;
}

export interface ConnectFourAIConfig {
  modelId: string;
  reasoningEffort: string;
}

export interface ConnectFourMatchRecord {
  id: string;
  timestamp: string;
  mode: ConnectFourGameMode;
  redModel?: string;
  yellowModel?: string;
  redReasoningEffort?: string;
  yellowReasoningEffort?: string;
  result: ConnectFourPlayer | "draw";
  moves: number;
  durationMs: number;
  avgAiResponseMs?: number;
  invalidResponses?: number;
  fallbackMoves?: number;
}
