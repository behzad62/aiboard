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
} from "@/lib/games/chess/types";

export const CHESS_ACTIVE_SESSION_ID = "chess-active-session";

const CHESS_SESSION_VERSION = 1;

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

function isGameStatus(value: unknown): value is GameStatus {
  return (
    value === "playing" ||
    value === "check" ||
    value === "checkmate" ||
    value === "stalemate" ||
    value === "draw" ||
    value === "paused"
  );
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "default" ||
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
    Array.isArray(value.board) &&
    isPieceColor(value.turn) &&
    isPlainObject(value.castlingRights) &&
    (typeof value.enPassantTarget === "string" ||
      value.enPassantTarget === null) &&
    Number.isFinite(value.halfmoveClock) &&
    Number.isFinite(value.fullmoveNumber) &&
    isGameStatus(value.status) &&
    (isPieceColor(value.winner) || value.winner === null) &&
    Array.isArray(value.moveHistory)
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
