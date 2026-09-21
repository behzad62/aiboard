import type { ReasoningEffort } from "@/lib/db/schema";
import type { QuoridorAIDiagnosticAttempt } from "@/lib/games/quoridor/ai";
import type {
  GameAIInteraction,
  GameParticipant,
  GameSessionRecord,
  GameSessionStatus,
} from "@/lib/games/core/types";
import {
  QUORIDOR_SIZE,
  QUORIDOR_WALL_GRID,
  QUORIDOR_WALLS_PER_PLAYER,
} from "@/lib/games/quoridor/engine";
import type {
  QuoridorAction,
  QuoridorClockState,
  QuoridorGameMode,
  QuoridorGameState,
  QuoridorMoveRecord,
  QuoridorPlayer,
  QuoridorSnapshot,
  QuoridorStatus,
  QuoridorWall,
  QuoridorWallOrientation,
} from "@/lib/games/quoridor/types";

export const QUORIDOR_ACTIVE_SESSION_ID = "quoridor-active-session";

const QUORIDOR_SESSION_VERSION = 1;

export interface QuoridorSessionAIConfig {
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

export interface QuoridorSessionSnapshot {
  gameState: QuoridorGameState;
  gameMode: QuoridorGameMode;
  humanPlayer: QuoridorPlayer;
  southAI: QuoridorSessionAIConfig;
  northAI: QuoridorSessionAIConfig;
  isPaused: boolean;
  lastAiInteraction: GameAIInteraction | null;
  aiWarning: string | null;
  aiError: string | null;
  aiDiagnostics?: QuoridorAIDiagnosticAttempt[];
}

export function isQuoridorActiveStatus(status: QuoridorStatus): boolean {
  return status === "playing" || status === "paused";
}

export function createQuoridorSessionRecord(
  snapshot: QuoridorSessionSnapshot,
  now = new Date().toISOString(),
  createdAt = now
): GameSessionRecord {
  return {
    id: QUORIDOR_ACTIVE_SESSION_ID,
    gameId: "quoridor",
    title: quoridorSessionTitle(snapshot.gameMode),
    status: quoridorSessionStatus(snapshot),
    participants: quoridorParticipants(snapshot),
    stateJson: JSON.stringify(snapshot),
    metadataJson: JSON.stringify({
      version: QUORIDOR_SESSION_VERSION,
      savedAt: now,
      moves: snapshot.gameState.moveHistory.length,
    }),
    createdAt,
    updatedAt: now,
  };
}

export function parseQuoridorSessionRecord(
  record: GameSessionRecord
): QuoridorSessionSnapshot | null {
  if (record.gameId !== "quoridor") return null;

  const metadata = parseJson(record.metadataJson);
  if (
    !isPlainObject(metadata) ||
    metadata.version !== QUORIDOR_SESSION_VERSION
  ) {
    return null;
  }

  const parsed = parseJson(record.stateJson);
  if (!isPlainObject(parsed)) return null;
  const gameState = normalizeQuoridorGameState(parsed.gameState);
  if (!gameState) return null;
  if (!isGameMode(parsed.gameMode)) return null;
  if (!isPlayer(parsed.humanPlayer)) return null;
  if (!isAIConfig(parsed.southAI) || !isAIConfig(parsed.northAI)) return null;
  if (typeof parsed.isPaused !== "boolean") return null;
  if (
    parsed.lastAiInteraction !== null &&
    !isGameAIInteraction(parsed.lastAiInteraction)
  ) {
    return null;
  }
  if (!isNullableString(parsed.aiWarning)) return null;
  if (!isNullableString(parsed.aiError)) return null;
  if (
    parsed.aiDiagnostics !== undefined &&
    !isAIDiagnosticAttemptArray(parsed.aiDiagnostics)
  ) {
    return null;
  }

  return {
    gameState,
    gameMode: parsed.gameMode,
    humanPlayer: parsed.humanPlayer,
    southAI: parsed.southAI,
    northAI: parsed.northAI,
    isPaused: parsed.isPaused,
    lastAiInteraction: parsed.lastAiInteraction,
    aiWarning: parsed.aiWarning,
    aiError: parsed.aiError,
    ...(parsed.aiDiagnostics !== undefined
      ? { aiDiagnostics: parsed.aiDiagnostics }
      : {}),
  };
}

function quoridorSessionTitle(mode: QuoridorGameMode): string {
  switch (mode) {
    case "pvai":
      return "Quoridor: Player vs AI";
    case "aivai":
      return "Quoridor: AI vs AI";
    case "pvp":
    default:
      return "Quoridor: Player vs Player";
  }
}

function quoridorSessionStatus(
  snapshot: QuoridorSessionSnapshot
): GameSessionStatus {
  if (snapshot.isPaused || snapshot.gameState.status === "paused") {
    return "paused";
  }

  return isQuoridorActiveStatus(snapshot.gameState.status)
    ? "active"
    : "complete";
}

function quoridorParticipants(
  snapshot: QuoridorSessionSnapshot
): GameParticipant[] {
  const southKind =
    snapshot.gameMode === "aivai" ||
    (snapshot.gameMode === "pvai" && snapshot.humanPlayer === "north")
      ? "ai"
      : "human";
  const northKind =
    snapshot.gameMode === "aivai" ||
    (snapshot.gameMode === "pvai" && snapshot.humanPlayer === "south")
      ? "ai"
      : "human";

  return [
    participant("south", southKind, snapshot.southAI),
    participant("north", northKind, snapshot.northAI),
  ];
}

function participant(
  player: QuoridorPlayer,
  kind: GameParticipant["kind"],
  aiConfig: QuoridorSessionAIConfig
): GameParticipant {
  const label = `${player === "south" ? "South" : "North"} ${
    kind === "ai" ? "AI" : "Player"
  }`;

  return kind === "ai"
    ? {
        id: player,
        kind,
        label,
        modelId: aiConfig.modelId || undefined,
        reasoningEffort: aiConfig.reasoningEffort,
      }
    : { id: player, kind, label };
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

function isGameMode(value: unknown): value is QuoridorGameMode {
  return value === "pvp" || value === "pvai" || value === "aivai";
}

function isPlayer(value: unknown): value is QuoridorPlayer {
  return value === "south" || value === "north";
}

function isStatus(value: unknown): value is QuoridorStatus {
  return value === "playing" || value === "paused" || value === "win";
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

function isAIConfig(value: unknown): value is QuoridorSessionAIConfig {
  return (
    isPlainObject(value) &&
    typeof value.modelId === "string" &&
    isReasoningEffort(value.reasoningEffort)
  );
}

function isBoardIndex(value: unknown, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < max
  );
}

function isSquare(value: unknown): value is QuoridorGameState["pawns"]["south"] {
  return (
    isPlainObject(value) &&
    isBoardIndex(value.row, QUORIDOR_SIZE) &&
    isBoardIndex(value.col, QUORIDOR_SIZE)
  );
}

function isOrientation(value: unknown): value is QuoridorWallOrientation {
  return value === "H" || value === "V";
}

function isWall(value: unknown): value is QuoridorWall {
  return (
    isPlainObject(value) &&
    isBoardIndex(value.row, QUORIDOR_WALL_GRID) &&
    isBoardIndex(value.col, QUORIDOR_WALL_GRID) &&
    isOrientation(value.orientation)
  );
}

function isAction(value: unknown): value is QuoridorAction {
  if (!isPlainObject(value)) return false;
  if (value.type === "move") {
    return isBoardIndex(value.row, QUORIDOR_SIZE) && isBoardIndex(value.col, QUORIDOR_SIZE);
  }
  if (value.type === "wall") {
    return (
      isBoardIndex(value.row, QUORIDOR_WALL_GRID) &&
      isBoardIndex(value.col, QUORIDOR_WALL_GRID) &&
      isOrientation(value.orientation)
    );
  }
  return false;
}

function isSnapshot(value: unknown): value is QuoridorSnapshot {
  if (!isPlainObject(value)) return false;
  return (
    isPlainObject(value.pawns) &&
    isSquare(value.pawns.south) &&
    isSquare(value.pawns.north) &&
    Array.isArray(value.walls) &&
    value.walls.every(isWall) &&
    isPlainObject(value.wallsLeft) &&
    isWallCount(value.wallsLeft.south) &&
    isWallCount(value.wallsLeft.north)
  );
}

function isWallCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= QUORIDOR_WALLS_PER_PLAYER
  );
}

function isMoveRecord(value: unknown): value is QuoridorMoveRecord {
  if (!isPlainObject(value)) return false;
  return (
    isAction(value.action) &&
    isPlayer(value.player) &&
    typeof value.notation === "string" &&
    isSnapshot(value.snapshotAfter) &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp) &&
    (value.aiInteraction === undefined ||
      isGameAIInteraction(value.aiInteraction))
  );
}

function isClockState(value: unknown): value is QuoridorClockState {
  if (!isPlainObject(value)) return false;
  return (
    isNonNegativeFiniteNumber(value.southElapsedMs) &&
    isNonNegativeFiniteNumber(value.northElapsedMs) &&
    (value.turnStartedAt === null ||
      isNonNegativeFiniteNumber(value.turnStartedAt))
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isQuoridorGameState(value: unknown): value is QuoridorGameState {
  if (!isPlainObject(value)) return false;
  return (
    isSnapshot(value) &&
    isPlayer(value.turn) &&
    isStatus(value.status) &&
    (isPlayer(value.winner) || value.winner === null) &&
    Array.isArray(value.moveHistory) &&
    value.moveHistory.every(isMoveRecord) &&
    isClockState(value.clock)
  );
}

function normalizeQuoridorGameState(value: unknown): QuoridorGameState | null {
  return isQuoridorGameState(value) ? value : null;
}

function isGameAIInteraction(value: unknown): value is GameAIInteraction {
  if (!isPlainObject(value) || typeof value.actorId !== "string") {
    return false;
  }

  return (
    (value.gesture === undefined || isGameAIInteractionGesture(value.gesture)) &&
    (value.utterance === undefined || typeof value.utterance === "string") &&
    (value.confidence === undefined || isNormalizedConfidence(value.confidence)) &&
    (value.diagnostics === undefined || typeof value.diagnostics === "string")
  );
}

function isGameAIInteractionGesture(
  value: unknown
): value is NonNullable<GameAIInteraction["gesture"]> {
  return (
    value === "thinking" ||
    value === "confident" ||
    value === "confused" ||
    value === "celebrating" ||
    value === "apologetic" ||
    value === "neutral"
  );
}

function isNormalizedConfidence(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isAIDiagnosticAttemptArray(
  value: unknown
): value is QuoridorAIDiagnosticAttempt[] {
  return Array.isArray(value) && value.every(isAIDiagnosticAttempt);
}

function isAIDiagnosticAttempt(
  value: unknown
): value is QuoridorAIDiagnosticAttempt {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.attempt === "number" &&
    Number.isInteger(value.attempt) &&
    value.attempt > 0 &&
    (value.type === "parse" ||
      value.type === "illegal" ||
      value.type === "request") &&
    typeof value.message === "string" &&
    Array.isArray(value.legalActions) &&
    value.legalActions.every((action) => typeof action === "string") &&
    (value.rawResponse === undefined || typeof value.rawResponse === "string") &&
    (value.rejectedAction === undefined || typeof value.rejectedAction === "string")
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
