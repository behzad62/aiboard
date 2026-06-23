/**
 * Chess game types and interfaces
 */

// Piece definitions
export type PieceColor = "white" | "black";
export type PieceType = "pawn" | "knight" | "bishop" | "rook" | "queen" | "king";

export interface Piece {
  color: PieceColor;
  type: PieceType;
}

// Board representation
// Square uses algebraic notation: "a1" to "h8"
export type Square = string;

// 8x8 board: [0][0] = a8 (top-left from white's perspective), [7][7] = h1
export type Board = (Piece | null)[][];

// Move representation
export interface Move {
  from: Square;
  to: Square;
  promotion?: PieceType;
}

// Castling rights tracking
export interface CastlingRights {
  whiteKingside: boolean;
  whiteQueenside: boolean;
  blackKingside: boolean;
  blackQueenside: boolean;
}

// Game status
export type GameStatus =
  | "playing"
  | "check"
  | "checkmate"
  | "stalemate"
  | "draw"
  | "paused"
  | "timeout";

// Move history record with full context
export interface MoveRecord {
  move: Move;
  san: string;
  fenBefore: string;
  fenAfter: string;
  timestamp: number;
}

// Complete game state
export interface GameState {
  board: Board;
  turn: PieceColor;
  castlingRights: CastlingRights;
  enPassantTarget: Square | null;
  halfmoveClock: number;
  fullmoveNumber: number;
  status: GameStatus;
  winner: PieceColor | null;
  moveHistory: MoveRecord[];
}

// AI request/response interfaces for LLM integration
export interface ChessAIRequest {
  fen: string;
  turn: PieceColor;
  legalMoves: Move[];
  moveHistory: string[];
}

export interface ChessAIResponse {
  from: string;
  to: string;
  promotion?: string;
  reasoning?: string;
}

// Game mode types
export type GameMode = "pvp" | "pvai" | "aivai";

// Match record for game history/stats
export interface GameMatchRecord {
  id: string;
  timestamp: string;
  mode: GameMode;
  whiteModel?: string;
  blackModel?: string;
  whiteReasoningEffort?: string;
  blackReasoningEffort?: string;
  result: "white" | "black" | "draw";
  moves: number;
  durationMs: number;
  whiteMoveMs: number;
  blackMoveMs: number;
}

// Per-model statistics
export interface GameModelStat {
  modelId: string;
  displayName: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  totalMoves: number;
  totalMoveMs: number;
  avgMoveMs: number;
  lastPlayed: string;
}
