import type { ReasoningEffort } from "@/lib/db/schema";
import type { ConnectFourAIDiagnosticAttempt } from "@/lib/games/connect-four/ai";
import type {
  GameAIInteraction,
  GameParticipant,
  GameSessionRecord,
  GameSessionStatus,
} from "@/lib/games/core/types";
import { CONNECT_FOUR_COLUMNS, CONNECT_FOUR_ROWS } from "@/lib/games/connect-four/engine";
import type {
  ConnectFourBoard,
  ConnectFourClockState,
  ConnectFourGameMode,
  ConnectFourGameState,
  ConnectFourPlayer,
  ConnectFourStatus,
} from "@/lib/games/connect-four/types";

export const CONNECT_FOUR_ACTIVE_SESSION_ID = "connect-four-active-session";

const CONNECT_FOUR_SESSION_VERSION = 1;

export interface ConnectFourSessionAIConfig {
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

export interface ConnectFourSessionSnapshot {
  gameState: ConnectFourGameState;
  gameMode: ConnectFourGameMode;
  humanPlayer: ConnectFourPlayer;
  redAI: ConnectFourSessionAIConfig;
  yellowAI: ConnectFourSessionAIConfig;
  isPaused: boolean;
  lastAiInteraction: GameAIInteraction | null;
  aiWarning: string | null;
  aiError: string | null;
  aiDiagnostics?: ConnectFourAIDiagnosticAttempt[];
}

export function isConnectFourActiveStatus(status: ConnectFourStatus): boolean {
  return status === "playing" || status === "paused";
}

export function createConnectFourSessionRecord(
  snapshot: ConnectFourSessionSnapshot,
  now = new Date().toISOString(),
  createdAt = now
): GameSessionRecord {
  return {
    id: CONNECT_FOUR_ACTIVE_SESSION_ID,
    gameId: "connect-four",
    title: connectFourSessionTitle(snapshot.gameMode),
    status: connectFourSessionStatus(snapshot),
    participants: connectFourParticipants(snapshot),
    stateJson: JSON.stringify(snapshot),
    metadataJson: JSON.stringify({
      version: CONNECT_FOUR_SESSION_VERSION,
      savedAt: now,
      moves: snapshot.gameState.moveHistory.length,
    }),
    createdAt,
    updatedAt: now,
  };
}

export function parseConnectFourSessionRecord(
  record: GameSessionRecord
): ConnectFourSessionSnapshot | null {
  if (record.gameId !== "connect-four") return null;

  const metadata = parseJson(record.metadataJson);
  if (
    !isPlainObject(metadata) ||
    metadata.version !== CONNECT_FOUR_SESSION_VERSION
  ) {
    return null;
  }

  const parsed = parseJson(record.stateJson);
  if (!isPlainObject(parsed)) return null;
  const gameState = normalizeConnectFourGameState(parsed.gameState);
  if (!gameState) return null;
  if (!isGameMode(parsed.gameMode)) return null;
  if (!isPlayer(parsed.humanPlayer)) return null;
  if (!isAIConfig(parsed.redAI) || !isAIConfig(parsed.yellowAI)) return null;
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
    redAI: parsed.redAI,
    yellowAI: parsed.yellowAI,
    isPaused: parsed.isPaused,
    lastAiInteraction: parsed.lastAiInteraction,
    aiWarning: parsed.aiWarning,
    aiError: parsed.aiError,
    ...(parsed.aiDiagnostics !== undefined
      ? { aiDiagnostics: parsed.aiDiagnostics }
      : {}),
  };
}

function connectFourSessionTitle(mode: ConnectFourGameMode): string {
  switch (mode) {
    case "pvai":
      return "Connect Four: Player vs AI";
    case "aivai":
      return "Connect Four: AI vs AI";
    case "pvp":
    default:
      return "Connect Four: Player vs Player";
  }
}

function connectFourSessionStatus(
  snapshot: ConnectFourSessionSnapshot
): GameSessionStatus {
  if (snapshot.isPaused || snapshot.gameState.status === "paused") {
    return "paused";
  }

  return isConnectFourActiveStatus(snapshot.gameState.status)
    ? "active"
    : "complete";
}

function connectFourParticipants(
  snapshot: ConnectFourSessionSnapshot
): GameParticipant[] {
  const redKind =
    snapshot.gameMode === "aivai" ||
    (snapshot.gameMode === "pvai" && snapshot.humanPlayer === "yellow")
      ? "ai"
      : "human";
  const yellowKind =
    snapshot.gameMode === "aivai" ||
    (snapshot.gameMode === "pvai" && snapshot.humanPlayer === "red")
      ? "ai"
      : "human";

  return [
    participant("red", redKind, snapshot.redAI),
    participant("yellow", yellowKind, snapshot.yellowAI),
  ];
}

function participant(
  player: ConnectFourPlayer,
  kind: GameParticipant["kind"],
  aiConfig: ConnectFourSessionAIConfig
): GameParticipant {
  const label = `${player === "red" ? "Red" : "Yellow"} ${
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

function isGameMode(value: unknown): value is ConnectFourGameMode {
  return value === "pvp" || value === "pvai" || value === "aivai";
}

function isPlayer(value: unknown): value is ConnectFourPlayer {
  return value === "red" || value === "yellow";
}

function isStatus(value: unknown): value is ConnectFourStatus {
  return (
    value === "playing" ||
    value === "paused" ||
    value === "win" ||
    value === "draw"
  );
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

function isAIConfig(value: unknown): value is ConnectFourSessionAIConfig {
  return (
    isPlainObject(value) &&
    typeof value.modelId === "string" &&
    isReasoningEffort(value.reasoningEffort)
  );
}

function isConnectFourGameState(value: unknown): value is ConnectFourGameState {
  if (!isPlainObject(value)) return false;

  return (
    isBoard(value.board) &&
    isPlayer(value.turn) &&
    isStatus(value.status) &&
    (isPlayer(value.winner) || value.winner === null) &&
    isMoveHistory(value.moveHistory) &&
    isClockState(value.clock)
  );
}

function normalizeConnectFourGameState(
  value: unknown
): ConnectFourGameState | null {
  if (!isPlainObject(value)) return null;
  const candidate = {
    ...value,
    clock: isClockState(value.clock)
      ? value.clock
      : inferClockFromLegacyState(value),
  };

  return isConnectFourGameState(candidate) ? candidate : null;
}

function inferClockFromLegacyState(
  value: Record<string, unknown>
): ConnectFourClockState {
  const moveHistory = isMoveHistory(value.moveHistory) ? value.moveHistory : [];
  const elapsed: ConnectFourClockState = {
    redElapsedMs: 0,
    yellowElapsedMs: 0,
    turnStartedAt:
      value.status === "playing" && isPlayer(value.turn) ? Date.now() : null,
  };

  let previousTimestamp = moveHistory[0]?.timestamp ?? null;
  for (const record of moveHistory) {
    if (previousTimestamp === null) {
      previousTimestamp = record.timestamp;
      continue;
    }

    const delta = Math.max(0, record.timestamp - previousTimestamp);
    if (record.player === "red") {
      elapsed.redElapsedMs += delta;
    } else {
      elapsed.yellowElapsedMs += delta;
    }
    previousTimestamp = record.timestamp;
  }

  return elapsed;
}

function isClockState(value: unknown): value is ConnectFourClockState {
  if (!isPlainObject(value)) return false;

  return (
    isNonNegativeFiniteNumber(value.redElapsedMs) &&
    isNonNegativeFiniteNumber(value.yellowElapsedMs) &&
    (value.turnStartedAt === null || isNonNegativeFiniteNumber(value.turnStartedAt))
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoard(value: unknown): value is ConnectFourBoard {
  return (
    Array.isArray(value) &&
    value.length === CONNECT_FOUR_ROWS &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === CONNECT_FOUR_COLUMNS &&
        row.every((cell) => cell === null || isPlayer(cell))
    )
  );
}

function isMoveHistory(
  value: unknown
): value is ConnectFourGameState["moveHistory"] {
  return Array.isArray(value) && value.every(isMoveRecord);
}

function isMoveRecord(
  value: unknown
): value is ConnectFourGameState["moveHistory"][number] {
  if (!isPlainObject(value)) return false;

  return (
    isPlainObject(value.move) &&
    isColumn(value.move.column) &&
    isPlayer(value.player) &&
    typeof value.displayColumn === "number" &&
    Number.isInteger(value.displayColumn) &&
    value.displayColumn >= 1 &&
    value.displayColumn <= CONNECT_FOUR_COLUMNS &&
    isBoard(value.boardAfter) &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp) &&
    (value.aiInteraction === undefined ||
      isGameAIInteraction(value.aiInteraction))
  );
}

function isColumn(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < CONNECT_FOUR_COLUMNS
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
): value is ConnectFourAIDiagnosticAttempt[] {
  return Array.isArray(value) && value.every(isAIDiagnosticAttempt);
}

function isAIDiagnosticAttempt(
  value: unknown
): value is ConnectFourAIDiagnosticAttempt {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.attempt === "number" &&
    Number.isInteger(value.attempt) &&
    value.attempt > 0 &&
    (value.type === "parse" ||
      value.type === "illegal" ||
      value.type === "request") &&
    typeof value.message === "string" &&
    Array.isArray(value.legalColumns) &&
    value.legalColumns.every((column) => Number.isInteger(column)) &&
    (value.rawResponse === undefined || typeof value.rawResponse === "string") &&
    (value.rejectedColumn === undefined ||
      Number.isInteger(value.rejectedColumn))
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
