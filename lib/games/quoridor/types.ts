import type { GameAIInteraction } from "../core/types";

export type QuoridorPlayer = "south" | "north";
export type QuoridorStatus = "playing" | "paused" | "win";
export type QuoridorGameMode = "pvp" | "pvai" | "aivai";
export type QuoridorWallOrientation = "H" | "V";

export interface QuoridorSquare {
  row: number;
  col: number;
}

export interface QuoridorWall {
  row: number;
  col: number;
  orientation: QuoridorWallOrientation;
}

export type QuoridorAction =
  | { type: "move"; row: number; col: number }
  | { type: "wall"; row: number; col: number; orientation: QuoridorWallOrientation };

export interface QuoridorMoveRecord {
  action: QuoridorAction;
  player: QuoridorPlayer;
  notation: string;
  snapshotAfter: QuoridorSnapshot;
  timestamp: number;
  aiInteraction?: GameAIInteraction;
}

export interface QuoridorSnapshot {
  pawns: Record<QuoridorPlayer, QuoridorSquare>;
  walls: QuoridorWall[];
  wallsLeft: Record<QuoridorPlayer, number>;
}

export interface QuoridorClockState {
  southElapsedMs: number;
  northElapsedMs: number;
  turnStartedAt: number | null;
}

export interface QuoridorGameState extends QuoridorSnapshot {
  turn: QuoridorPlayer;
  status: QuoridorStatus;
  winner: QuoridorPlayer | null;
  moveHistory: QuoridorMoveRecord[];
  clock: QuoridorClockState;
}

export interface QuoridorAIResponse {
  action: QuoridorAction;
  reasoning?: string;
  gesture?: GameAIInteraction["gesture"];
  utterance?: string;
  confidence?: number;
  diagnostics?: string;
}

export interface QuoridorAIConfig {
  modelId: string;
  reasoningEffort: string;
}
