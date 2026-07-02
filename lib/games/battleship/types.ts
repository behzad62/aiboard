import type { GameAIInteraction } from "../core/types";

export type BattleshipPlayer = "blue" | "orange";
export type BattleshipStatus = "playing" | "paused" | "win";
export type BattleshipGameMode = "pvp" | "pvai" | "aivai";
export type BattleshipShotResult = "miss" | "hit" | "sunk";
export type BattleshipOrientation = "horizontal" | "vertical";

export interface BattleshipCoordinate {
  row: number;
  column: number;
}

export interface BattleshipShipDefinition {
  id: string;
  name: string;
  size: number;
}

export interface BattleshipShip extends BattleshipShipDefinition {
  cells: BattleshipCoordinate[];
}

export interface BattleshipShipPlacement {
  id: string;
  start: string;
  orientation: BattleshipOrientation;
}

export type BattleshipFleetValidationResult =
  | { ok: true; ships: BattleshipShip[] }
  | { ok: false; error: string };

export interface BattleshipShotRecord {
  target: BattleshipCoordinate;
  result: BattleshipShotResult;
  shipId?: string;
  sunkShipId?: string;
  timestamp: number;
}

export interface BattleshipPlayerBoard {
  ships: BattleshipShip[];
  shotsReceived: BattleshipShotRecord[];
}

export interface BattleshipMoveRecord extends BattleshipShotRecord {
  player: BattleshipPlayer;
  displayTarget: string;
  aiInteraction?: GameAIInteraction;
}

export interface BattleshipGameState {
  boards: Record<BattleshipPlayer, BattleshipPlayerBoard>;
  turn: BattleshipPlayer;
  status: BattleshipStatus;
  winner: BattleshipPlayer | null;
  moveHistory: BattleshipMoveRecord[];
  aiStrategyNotes?: Partial<Record<BattleshipPlayer, string>>;
}

export interface BattleshipAIResponse {
  target: BattleshipCoordinate;
  reasoning?: string;
  strategyNote?: string;
  gesture?: GameAIInteraction["gesture"];
  utterance?: string;
  confidence?: number;
  diagnostics?: string;
}
