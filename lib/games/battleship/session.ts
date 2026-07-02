import type { ReasoningEffort } from "@/lib/db/schema";
import type { BattleshipAIDiagnosticAttempt } from "@/lib/games/battleship/ai";
import { BATTLESHIP_BOARD_SIZE, BATTLESHIP_FLEET } from "@/lib/games/battleship/engine";
import type {
  BattleshipCoordinate,
  BattleshipGameMode,
  BattleshipGameState,
  BattleshipPlayer,
  BattleshipPlayerBoard,
  BattleshipShip,
  BattleshipShotRecord,
  BattleshipShotResult,
  BattleshipStatus,
} from "@/lib/games/battleship/types";
import type {
  GameAIInteraction,
  GameParticipant,
  GameSessionRecord,
  GameSessionStatus,
} from "@/lib/games/core/types";

export const BATTLESHIP_ACTIVE_SESSION_ID = "battleship-active-session";

const BATTLESHIP_SESSION_VERSION = 1;

export interface BattleshipSessionAIConfig {
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

export interface BattleshipSessionSnapshot {
  gameState: BattleshipGameState;
  gameMode: BattleshipGameMode;
  humanPlayer: BattleshipPlayer;
  blueAI: BattleshipSessionAIConfig;
  orangeAI: BattleshipSessionAIConfig;
  isPaused: boolean;
  lastAiInteraction: GameAIInteraction | null;
  aiWarning: string | null;
  aiError: string | null;
  aiDiagnostics?: BattleshipAIDiagnosticAttempt[];
}

export function isBattleshipActiveStatus(status: BattleshipStatus): boolean {
  return status === "playing" || status === "paused";
}

export function createBattleshipSessionRecord(
  snapshot: BattleshipSessionSnapshot,
  now = new Date().toISOString(),
  createdAt = now
): GameSessionRecord {
  return {
    id: BATTLESHIP_ACTIVE_SESSION_ID,
    gameId: "battleship",
    title: battleshipSessionTitle(snapshot.gameMode),
    status: battleshipSessionStatus(snapshot),
    participants: battleshipParticipants(snapshot),
    stateJson: JSON.stringify(snapshot),
    metadataJson: JSON.stringify({
      version: BATTLESHIP_SESSION_VERSION,
      savedAt: now,
      moves: snapshot.gameState.moveHistory.length,
    }),
    createdAt,
    updatedAt: now,
  };
}

export function parseBattleshipSessionRecord(
  record: GameSessionRecord
): BattleshipSessionSnapshot | null {
  if (record.gameId !== "battleship") return null;

  const metadata = parseJson(record.metadataJson);
  if (
    !isPlainObject(metadata) ||
    metadata.version !== BATTLESHIP_SESSION_VERSION
  ) {
    return null;
  }

  const parsed = parseJson(record.stateJson);
  if (!isPlainObject(parsed)) return null;
  if (!isBattleshipGameState(parsed.gameState)) return null;
  if (!isGameMode(parsed.gameMode)) return null;
  if (!isPlayer(parsed.humanPlayer)) return null;
  if (!isAIConfig(parsed.blueAI) || !isAIConfig(parsed.orangeAI)) return null;
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
    gameState: parsed.gameState,
    gameMode: parsed.gameMode,
    humanPlayer: parsed.humanPlayer,
    blueAI: parsed.blueAI,
    orangeAI: parsed.orangeAI,
    isPaused: parsed.isPaused,
    lastAiInteraction: parsed.lastAiInteraction,
    aiWarning: parsed.aiWarning,
    aiError: parsed.aiError,
    ...(parsed.aiDiagnostics !== undefined
      ? { aiDiagnostics: parsed.aiDiagnostics }
      : {}),
  };
}

function battleshipSessionTitle(mode: BattleshipGameMode): string {
  switch (mode) {
    case "pvai":
      return "Battleship: Player vs AI";
    case "aivai":
      return "Battleship: AI vs AI";
    case "pvp":
    default:
      return "Battleship: Player vs Player";
  }
}

function battleshipSessionStatus(
  snapshot: BattleshipSessionSnapshot
): GameSessionStatus {
  if (snapshot.isPaused || snapshot.gameState.status === "paused") {
    return "paused";
  }

  return isBattleshipActiveStatus(snapshot.gameState.status)
    ? "active"
    : "complete";
}

function battleshipParticipants(
  snapshot: BattleshipSessionSnapshot
): GameParticipant[] {
  const blueKind =
    snapshot.gameMode === "aivai" ||
    (snapshot.gameMode === "pvai" && snapshot.humanPlayer === "orange")
      ? "ai"
      : "human";
  const orangeKind =
    snapshot.gameMode === "aivai" ||
    (snapshot.gameMode === "pvai" && snapshot.humanPlayer === "blue")
      ? "ai"
      : "human";

  return [
    participant("blue", blueKind, snapshot.blueAI),
    participant("orange", orangeKind, snapshot.orangeAI),
  ];
}

function participant(
  player: BattleshipPlayer,
  kind: GameParticipant["kind"],
  aiConfig: BattleshipSessionAIConfig
): GameParticipant {
  const label = `${player === "blue" ? "Blue" : "Orange"} ${
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

function isGameMode(value: unknown): value is BattleshipGameMode {
  return value === "pvp" || value === "pvai" || value === "aivai";
}

function isPlayer(value: unknown): value is BattleshipPlayer {
  return value === "blue" || value === "orange";
}

function isStatus(value: unknown): value is BattleshipStatus {
  return value === "playing" || value === "paused" || value === "win";
}

function isShotResult(value: unknown): value is BattleshipShotResult {
  return value === "miss" || value === "hit" || value === "sunk";
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

function isAIConfig(value: unknown): value is BattleshipSessionAIConfig {
  return (
    isPlainObject(value) &&
    typeof value.modelId === "string" &&
    isReasoningEffort(value.reasoningEffort)
  );
}

function isBattleshipGameState(value: unknown): value is BattleshipGameState {
  if (!isPlainObject(value)) return false;

  return (
    isPlainObject(value.boards) &&
    isPlayerBoard(value.boards.blue) &&
    isPlayerBoard(value.boards.orange) &&
    isPlayer(value.turn) &&
    isStatus(value.status) &&
    (isPlayer(value.winner) || value.winner === null) &&
    Array.isArray(value.moveHistory) &&
    value.moveHistory.every(isMoveRecord)
  );
}

function isPlayerBoard(value: unknown): value is BattleshipPlayerBoard {
  if (!isPlainObject(value)) return false;

  return (
    Array.isArray(value.ships) &&
    value.ships.length === BATTLESHIP_FLEET.length &&
    value.ships.every(isShip) &&
    Array.isArray(value.shotsReceived) &&
    value.shotsReceived.every(isShotRecord)
  );
}

function isShip(value: unknown): value is BattleshipShip {
  if (!isPlainObject(value)) return false;
  const definition = BATTLESHIP_FLEET.find((ship) => ship.id === value.id);

  return (
    Boolean(definition) &&
    typeof value.name === "string" &&
    value.name === definition?.name &&
    value.size === definition.size &&
    Array.isArray(value.cells) &&
    value.cells.length === definition.size &&
    value.cells.every(isCoordinate)
  );
}

function isShotRecord(value: unknown): value is BattleshipShotRecord {
  if (!isPlainObject(value)) return false;

  return (
    isCoordinate(value.target) &&
    isShotResult(value.result) &&
    (value.shipId === undefined || typeof value.shipId === "string") &&
    (value.sunkShipId === undefined || typeof value.sunkShipId === "string") &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp)
  );
}

function isMoveRecord(
  value: unknown
): value is BattleshipGameState["moveHistory"][number] {
  return (
    isShotRecord(value) &&
    isPlainObject(value) &&
    isPlayer(value.player) &&
    typeof value.displayTarget === "string" &&
    (value.aiInteraction === undefined ||
      isGameAIInteraction(value.aiInteraction))
  );
}

function isCoordinate(value: unknown): value is BattleshipCoordinate {
  if (!isPlainObject(value)) return false;
  const { row, column } = value;

  return (
    Number.isInteger(row) &&
    Number.isInteger(column) &&
    typeof row === "number" &&
    typeof column === "number" &&
    row >= 0 &&
    row < BATTLESHIP_BOARD_SIZE &&
    column >= 0 &&
    column < BATTLESHIP_BOARD_SIZE
  );
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
): value is BattleshipAIDiagnosticAttempt[] {
  return Array.isArray(value) && value.every(isAIDiagnosticAttempt);
}

function isAIDiagnosticAttempt(
  value: unknown
): value is BattleshipAIDiagnosticAttempt {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.attempt === "number" &&
    Number.isInteger(value.attempt) &&
    value.attempt > 0 &&
    (value.type === "parse" ||
      value.type === "illegal" ||
      value.type === "request") &&
    typeof value.message === "string" &&
    Array.isArray(value.legalTargets) &&
    value.legalTargets.every((target) => typeof target === "string") &&
    (value.rawResponse === undefined || typeof value.rawResponse === "string") &&
    (value.rejectedTarget === undefined ||
      typeof value.rejectedTarget === "string")
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
