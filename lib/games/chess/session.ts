import type { ReasoningEffort } from "@/lib/db/schema";
import type {
  GameAIInteraction,
  GameParticipant,
  GameSessionRecord,
  GameSessionStatus,
} from "@/lib/games/core/types";
import type {
  GameMode,
  GameState,
  GameStatus,
  PieceColor,
  PieceType,
} from "@/lib/games/chess/types";

export const CHESS_ACTIVE_SESSION_ID = "chess-active-session";

const CHESS_SESSION_VERSION = 1;

export type ChessTimeControlMode =
  | "untimed"
  | "blitz-5-0"
  | "rapid-10-0"
  | "rapid-15-10"
  | "custom";

export interface ChessTimeControl {
  mode: ChessTimeControlMode;
  initialMs: number;
  incrementMs: number;
  label: string;
}

export const DEFAULT_CHESS_TIME_CONTROL: ChessTimeControl = {
  mode: "untimed",
  initialMs: 0,
  incrementMs: 0,
  label: "Untimed",
};

export interface ChessSessionAIConfig {
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

export interface ChessSessionSnapshot {
  gameMode: GameMode;
  humanColor: PieceColor;
  whiteAI: ChessSessionAIConfig;
  blackAI: ChessSessionAIConfig;
  gameState: GameState;
  whiteTimeMs: number;
  blackTimeMs: number;
  whiteRemainingMs: number | null;
  blackRemainingMs: number | null;
  timeControl: ChessTimeControl;
  gameStartTime: number;
  isPaused: boolean;
  lastAiInteraction: GameAIInteraction | null;
}

export function isChessActiveStatus(status: GameStatus): boolean {
  return status === "playing" || status === "check";
}

export function createChessSessionRecord(
  snapshot: ChessSessionSnapshot
): GameSessionRecord {
  const now = new Date().toISOString();
  const createdAt =
    Number.isFinite(snapshot.gameStartTime) && snapshot.gameStartTime > 0
      ? new Date(snapshot.gameStartTime).toISOString()
      : now;

  return {
    id: CHESS_ACTIVE_SESSION_ID,
    gameId: "chess",
    title: chessSessionTitle(snapshot.gameMode),
    status: chessSessionStatus(snapshot),
    participants: chessParticipants(snapshot),
    stateJson: JSON.stringify(snapshot),
    metadataJson: JSON.stringify({
      version: CHESS_SESSION_VERSION,
      savedAt: now,
    }),
    createdAt,
    updatedAt: now,
  };
}

export function parseChessSessionRecord(
  record: GameSessionRecord
): ChessSessionSnapshot | null {
  if (record.gameId !== "chess") return null;

  const metadata = parseJson(record.metadataJson);
  if (
    !isPlainObject(metadata) ||
    metadata.version !== CHESS_SESSION_VERSION
  ) {
    return null;
  }

  const parsed = parseJson(record.stateJson);
  if (!isPlainObject(parsed)) return null;
  if (!isGameMode(parsed.gameMode)) return null;
  if (!isPieceColor(parsed.humanColor)) return null;
  if (!isAIConfig(parsed.whiteAI) || !isAIConfig(parsed.blackAI)) return null;
  if (!isGameState(parsed.gameState)) return null;
  if (!isNonNegativeFiniteNumber(parsed.whiteTimeMs)) return null;
  if (!isNonNegativeFiniteNumber(parsed.blackTimeMs)) return null;
  const timeControl = parseTimeControl(parsed.timeControl);
  if (!timeControl) return null;
  const whiteRemainingMs = parseRemainingTime(
    parsed.whiteRemainingMs,
    timeControl
  );
  const blackRemainingMs = parseRemainingTime(
    parsed.blackRemainingMs,
    timeControl
  );
  if (whiteRemainingMs === undefined || blackRemainingMs === undefined) {
    return null;
  }
  if (
    typeof parsed.gameStartTime !== "number" ||
    !Number.isFinite(parsed.gameStartTime)
  ) {
    return null;
  }
  if (typeof parsed.isPaused !== "boolean") return null;

  return {
    gameMode: parsed.gameMode,
    humanColor: parsed.humanColor,
    whiteAI: parsed.whiteAI,
    blackAI: parsed.blackAI,
    gameState: parsed.gameState,
    whiteTimeMs: parsed.whiteTimeMs,
    blackTimeMs: parsed.blackTimeMs,
    whiteRemainingMs,
    blackRemainingMs,
    timeControl,
    gameStartTime: parsed.gameStartTime,
    isPaused: parsed.isPaused,
    lastAiInteraction: isGameAIInteraction(parsed.lastAiInteraction)
      ? parsed.lastAiInteraction
      : null,
  };
}

function chessSessionTitle(mode: GameMode): string {
  switch (mode) {
    case "pvai":
      return "Chess: Player vs AI";
    case "aivai":
      return "Chess: AI vs AI";
    case "pvp":
    default:
      return "Chess: Player vs Player";
  }
}

function chessSessionStatus(
  snapshot: ChessSessionSnapshot
): GameSessionStatus {
  if (snapshot.isPaused) return "paused";
  return isChessActiveStatus(snapshot.gameState.status) ? "active" : "complete";
}

function chessParticipants(
  snapshot: ChessSessionSnapshot
): GameParticipant[] {
  const whiteKind =
    snapshot.gameMode === "aivai" ||
    (snapshot.gameMode === "pvai" && snapshot.humanColor === "black")
      ? "ai"
      : "human";
  const blackKind =
    snapshot.gameMode === "aivai" ||
    (snapshot.gameMode === "pvai" && snapshot.humanColor === "white")
      ? "ai"
      : "human";

  return [
    participant("white", whiteKind, snapshot.whiteAI),
    participant("black", blackKind, snapshot.blackAI),
  ];
}

function participant(
  color: PieceColor,
  kind: GameParticipant["kind"],
  aiConfig: ChessSessionAIConfig
): GameParticipant {
  const label = `${color === "white" ? "White" : "Black"} ${
    kind === "ai" ? "AI" : "Player"
  }`;

  return kind === "ai"
    ? {
        id: color,
        kind,
        label,
        modelId: aiConfig.modelId || undefined,
        reasoningEffort: aiConfig.reasoningEffort,
      }
    : { id: color, kind, label };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGameMode(value: unknown): value is GameMode {
  return value === "pvp" || value === "pvai" || value === "aivai";
}

function isPieceColor(value: unknown): value is PieceColor {
  return value === "white" || value === "black";
}

function isPieceType(value: unknown): value is PieceType {
  return (
    value === "pawn" ||
    value === "knight" ||
    value === "bishop" ||
    value === "rook" ||
    value === "queen" ||
    value === "king"
  );
}

function isGameStatus(value: unknown): value is GameStatus {
  return (
    value === "playing" ||
    value === "check" ||
    value === "checkmate" ||
    value === "stalemate" ||
    value === "draw" ||
    value === "paused" ||
    value === "timeout"
  );
}

function parseTimeControl(value: unknown): ChessTimeControl | null {
  if (value === undefined) return DEFAULT_CHESS_TIME_CONTROL;
  if (!isPlainObject(value)) return null;
  if (!isTimeControlMode(value.mode)) return null;
  if (!isNonNegativeFiniteNumber(value.initialMs)) return null;
  if (!isNonNegativeFiniteNumber(value.incrementMs)) return null;

  const label = typeof value.label === "string" ? value.label : null;
  if (value.mode === "untimed") {
    return DEFAULT_CHESS_TIME_CONTROL;
  }

  if (value.initialMs <= 0) return null;

  return {
    mode: value.mode,
    initialMs: value.initialMs,
    incrementMs: value.incrementMs,
    label: label || timeControlLabel(value.mode, value.initialMs, value.incrementMs),
  };
}

function parseRemainingTime(
  value: unknown,
  timeControl: ChessTimeControl
): number | null | undefined {
  if (timeControl.mode === "untimed") {
    return null;
  }

  if (value === undefined || value === null) {
    return timeControl.initialMs;
  }

  return isNonNegativeFiniteNumber(value) ? value : undefined;
}

function isTimeControlMode(value: unknown): value is ChessTimeControlMode {
  return (
    value === "untimed" ||
    value === "blitz-5-0" ||
    value === "rapid-10-0" ||
    value === "rapid-15-10" ||
    value === "custom"
  );
}

function timeControlLabel(
  mode: ChessTimeControlMode,
  initialMs: number,
  incrementMs: number
): string {
  switch (mode) {
    case "blitz-5-0":
      return "5+0 blitz";
    case "rapid-10-0":
      return "10+0 rapid";
    case "rapid-15-10":
      return "15+10 rapid";
    case "custom":
      return `${formatMinutes(initialMs)}+${Math.round(incrementMs / 1000)} custom`;
    case "untimed":
    default:
      return DEFAULT_CHESS_TIME_CONTROL.label;
  }
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "default" ||
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "max"
  );
}

function isAIConfig(value: unknown): value is ChessSessionAIConfig {
  return (
    isPlainObject(value) &&
    typeof value.modelId === "string" &&
    isReasoningEffort(value.reasoningEffort)
  );
}

function isGameAIInteraction(value: unknown): value is GameAIInteraction {
  if (!isPlainObject(value) || typeof value.actorId !== "string") {
    return false;
  }

  return (
    (value.gesture === undefined || typeof value.gesture === "string") &&
    (value.utterance === undefined || typeof value.utterance === "string") &&
    (value.confidence === undefined || typeof value.confidence === "number") &&
    (value.diagnostics === undefined || typeof value.diagnostics === "string")
  );
}

function isGameState(value: unknown): value is GameState {
  if (!isPlainObject(value)) return false;

  return (
    isBoard(value.board) &&
    isPieceColor(value.turn) &&
    isCastlingRights(value.castlingRights) &&
    (isSquare(value.enPassantTarget) ||
      value.enPassantTarget === null) &&
    isNonNegativeFiniteNumber(value.halfmoveClock) &&
    isNonNegativeFiniteNumber(value.fullmoveNumber) &&
    isGameStatus(value.status) &&
    (isPieceColor(value.winner) || value.winner === null) &&
    isMoveHistory(value.moveHistory)
  );
}

function isBoard(value: unknown): value is GameState["board"] {
  return (
    Array.isArray(value) &&
    value.length === 8 &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 8 &&
        row.every((cell) => cell === null || isPiece(cell))
    )
  );
}

function isPiece(value: unknown): value is GameState["board"][number][number] {
  return (
    isPlainObject(value) &&
    isPieceColor(value.color) &&
    isPieceType(value.type)
  );
}

function isCastlingRights(
  value: unknown
): value is GameState["castlingRights"] {
  return (
    isPlainObject(value) &&
    typeof value.whiteKingside === "boolean" &&
    typeof value.whiteQueenside === "boolean" &&
    typeof value.blackKingside === "boolean" &&
    typeof value.blackQueenside === "boolean"
  );
}

function isMoveHistory(value: unknown): value is GameState["moveHistory"] {
  return Array.isArray(value) && value.every(isMoveRecord);
}

function isMoveRecord(
  value: unknown
): value is GameState["moveHistory"][number] {
  return (
    isPlainObject(value) &&
    isMove(value.move) &&
    typeof value.san === "string" &&
    typeof value.fenBefore === "string" &&
    typeof value.fenAfter === "string" &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp)
  );
}

function isMove(value: unknown): value is GameState["moveHistory"][number]["move"] {
  return (
    isPlainObject(value) &&
    isSquare(value.from) &&
    isSquare(value.to) &&
    (value.promotion === undefined || isPromotionPiece(value.promotion))
  );
}

function isSquare(value: unknown): value is string {
  return typeof value === "string" && /^[a-h][1-8]$/.test(value);
}

function isPromotionPiece(value: unknown): value is PieceType {
  return (
    value === "knight" ||
    value === "bishop" ||
    value === "rook" ||
    value === "queen"
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
