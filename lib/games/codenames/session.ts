import type { ReasoningEffort } from "@/lib/db/schema";
import type { CodenamesAIDiagnosticAttempt } from "@/lib/games/codenames/ai";
import { CODENAMES_CARD_COUNT } from "@/lib/games/codenames/engine";
import type {
  CodenamesCard,
  CodenamesCardRole,
  CodenamesClue,
  CodenamesGameMode,
  CodenamesGameState,
  CodenamesGuessResult,
  CodenamesPhase,
  CodenamesPlayerRole,
  CodenamesSeatAssignments,
  CodenamesStatus,
  CodenamesTeam,
} from "@/lib/games/codenames/types";
import type {
  GameAIInteraction,
  GameParticipant,
  GameSessionRecord,
  GameSessionStatus,
} from "@/lib/games/core/types";
import {
  codenamesCompositionLabel,
  isCodenamesSeatAssignments,
  seatAssignmentsFromLegacyMode,
} from "@/lib/games/codenames/seats";

export const CODENAMES_ACTIVE_SESSION_ID = "codenames-active-session";

const CODENAMES_SESSION_VERSION = 1;

export interface CodenamesSessionAIConfig {
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

export interface CodenamesPrivateView {
  team: CodenamesTeam;
  role: CodenamesPlayerRole;
}

export interface CodenamesSessionSnapshot {
  gameState: CodenamesGameState;
  seatAssignments: CodenamesSeatAssignments;
  redSpymasterAI: CodenamesSessionAIConfig;
  redOperativeAI: CodenamesSessionAIConfig;
  blueSpymasterAI: CodenamesSessionAIConfig;
  blueOperativeAI: CodenamesSessionAIConfig;
  isPaused: boolean;
  currentPrivateView: CodenamesPrivateView | null;
  lastAiInteraction: GameAIInteraction | null;
  aiWarning: string | null;
  aiError: string | null;
  aiDiagnostics?: CodenamesAIDiagnosticAttempt[];
}

export function isCodenamesActiveStatus(status: CodenamesStatus): boolean {
  return status === "playing" || status === "paused";
}

export function createCodenamesSessionRecord(
  snapshot: CodenamesSessionSnapshot,
  now = new Date().toISOString(),
  createdAt = now
): GameSessionRecord {
  return {
    id: CODENAMES_ACTIVE_SESSION_ID,
    gameId: "codenames",
    title: codenamesSessionTitle(snapshot.seatAssignments),
    status: codenamesSessionStatus(snapshot),
    participants: codenamesParticipants(snapshot),
    stateJson: JSON.stringify(snapshot),
    metadataJson: JSON.stringify({
      version: CODENAMES_SESSION_VERSION,
      savedAt: now,
      moves: snapshot.gameState.moveHistory.length,
    }),
    createdAt,
    updatedAt: now,
  };
}

export function parseCodenamesSessionRecord(
  record: GameSessionRecord
): CodenamesSessionSnapshot | null {
  if (record.gameId !== "codenames") return null;

  const metadata = parseJson(record.metadataJson);
  if (
    !isPlainObject(metadata) ||
    metadata.version !== CODENAMES_SESSION_VERSION
  ) {
    return null;
  }

  const parsed = parseJson(record.stateJson);
  if (!isPlainObject(parsed)) return null;
  if (!isCodenamesGameState(parsed.gameState)) return null;
  let seatAssignments: CodenamesSeatAssignments;
  if (isCodenamesSeatAssignments(parsed.seatAssignments)) {
    seatAssignments = parsed.seatAssignments;
  } else if (isGameMode(parsed.gameMode) && isTeam(parsed.humanTeam)) {
    seatAssignments = seatAssignmentsFromLegacyMode(
      parsed.gameMode,
      parsed.humanTeam
    );
  } else {
    return null;
  }
  if (
    !isAIConfig(parsed.redSpymasterAI) ||
    !isAIConfig(parsed.redOperativeAI) ||
    !isAIConfig(parsed.blueSpymasterAI) ||
    !isAIConfig(parsed.blueOperativeAI)
  ) {
    return null;
  }
  if (typeof parsed.isPaused !== "boolean") return null;
  if (
    parsed.currentPrivateView !== null &&
    !isPrivateView(parsed.currentPrivateView)
  ) {
    return null;
  }
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
    seatAssignments,
    redSpymasterAI: parsed.redSpymasterAI,
    redOperativeAI: parsed.redOperativeAI,
    blueSpymasterAI: parsed.blueSpymasterAI,
    blueOperativeAI: parsed.blueOperativeAI,
    isPaused: parsed.isPaused,
    currentPrivateView: parsed.currentPrivateView,
    lastAiInteraction: parsed.lastAiInteraction,
    aiWarning: parsed.aiWarning,
    aiError: parsed.aiError,
    ...(parsed.aiDiagnostics !== undefined
      ? { aiDiagnostics: parsed.aiDiagnostics }
      : {}),
  };
}

function codenamesSessionTitle(assignments: CodenamesSeatAssignments): string {
  return `Codenames: ${codenamesCompositionLabel(assignments)}`;
}

function codenamesSessionStatus(
  snapshot: CodenamesSessionSnapshot
): GameSessionStatus {
  if (snapshot.isPaused || snapshot.gameState.status === "paused") {
    return "paused";
  }

  return isCodenamesActiveStatus(snapshot.gameState.status)
    ? "active"
    : "complete";
}

function codenamesParticipants(snapshot: CodenamesSessionSnapshot): GameParticipant[] {
  const seats = snapshot.seatAssignments;
  return [
    seatParticipant("red", "spymaster", seats.redSpymaster, snapshot.redSpymasterAI),
    seatParticipant("red", "operative", seats.redOperative, snapshot.redOperativeAI),
    seatParticipant("blue", "spymaster", seats.blueSpymaster, snapshot.blueSpymasterAI),
    seatParticipant("blue", "operative", seats.blueOperative, snapshot.blueOperativeAI),
  ];
}

function seatParticipant(
  team: CodenamesTeam,
  role: CodenamesPlayerRole,
  kind: GameParticipant["kind"],
  aiConfig: CodenamesSessionAIConfig
): GameParticipant {
  const teamLabel = team === "red" ? "Red" : "Blue";
  const roleLabel = role === "spymaster" ? "Spymaster" : "Operative";
  const label = `${teamLabel} ${roleLabel}${kind === "ai" ? " AI" : ""}`;

  return kind === "ai"
    ? {
        id: `${team}-${role}`,
        kind,
        label,
        modelId: aiConfig.modelId || undefined,
        reasoningEffort: aiConfig.reasoningEffort,
      }
    : { id: `${team}-${role}`, kind, label };
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

function isGameMode(value: unknown): value is CodenamesGameMode {
  return value === "pvp" || value === "pvai" || value === "aivai";
}

function isTeam(value: unknown): value is CodenamesTeam {
  return value === "red" || value === "blue";
}

function isPlayerRole(value: unknown): value is CodenamesPlayerRole {
  return value === "spymaster" || value === "operative";
}

function isCardRole(value: unknown): value is CodenamesCardRole {
  return (
    value === "red" ||
    value === "blue" ||
    value === "neutral" ||
    value === "assassin"
  );
}

function isPhase(value: unknown): value is CodenamesPhase {
  return value === "clue" || value === "guess" || value === "finished";
}

function isStatus(value: unknown): value is CodenamesStatus {
  return value === "playing" || value === "paused" || value === "win";
}

function isGuessResult(value: unknown): value is CodenamesGuessResult {
  return (
    value === "own" ||
    value === "opponent" ||
    value === "neutral" ||
    value === "assassin"
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

function isAIConfig(value: unknown): value is CodenamesSessionAIConfig {
  return (
    isPlainObject(value) &&
    typeof value.modelId === "string" &&
    isReasoningEffort(value.reasoningEffort)
  );
}

function isPrivateView(value: unknown): value is CodenamesPrivateView {
  return (
    isPlainObject(value) &&
    isTeam(value.team) &&
    isPlayerRole(value.role)
  );
}

function isCodenamesGameState(value: unknown): value is CodenamesGameState {
  if (!isPlainObject(value)) return false;
  if (!isTeam(value.startingTeam) || !isTeam(value.turnTeam)) return false;
  if (!isPhase(value.phase) || !isStatus(value.status)) return false;
  if (!(isTeam(value.winner) || value.winner === null)) return false;
  if (!Array.isArray(value.cards) || !value.cards.every(isCard)) return false;
  if (!hasExpectedRoleCounts(value.cards, value.startingTeam)) return false;
  if (!(value.activeClue === null || isClue(value.activeClue))) return false;
  if (!isNonNegativeInteger(value.guessesRemaining)) return false;
  if (!isNonNegativeInteger(value.guessesMadeForActiveClue)) return false;
  if (!Array.isArray(value.moveHistory) || !value.moveHistory.every(isMoveRecord)) {
    return false;
  }

  if (value.phase === "guess" && value.activeClue === null) return false;
  if (value.phase === "clue" && value.activeClue !== null) return false;
  if (value.status === "win" && value.winner === null) return false;
  if (value.status !== "win" && value.winner !== null) return false;

  return true;
}

function isCard(value: unknown): value is CodenamesCard {
  return (
    isPlainObject(value) &&
    typeof value.id === "string" &&
    (value.position === undefined || typeof value.position === "string") &&
    typeof value.word === "string" &&
    value.word.trim().length > 0 &&
    isCardRole(value.role) &&
    typeof value.revealed === "boolean"
  );
}

function hasExpectedRoleCounts(
  cards: CodenamesCard[],
  startingTeam: CodenamesTeam
): boolean {
  if (cards.length !== CODENAMES_CARD_COUNT) return false;

  const ids = new Set<string>();
  const words = new Set<string>();
  const counts: Record<CodenamesCardRole, number> = {
    red: 0,
    blue: 0,
    neutral: 0,
    assassin: 0,
  };
  for (const card of cards) {
    const word = card.word.trim().toUpperCase();
    if (ids.has(card.id) || words.has(word)) return false;
    ids.add(card.id);
    words.add(word);
    counts[card.role] += 1;
  }

  const trailingTeam = startingTeam === "red" ? "blue" : "red";
  return (
    counts[startingTeam] === 9 &&
    counts[trailingTeam] === 8 &&
    counts.neutral === 7 &&
    counts.assassin === 1
  );
}

function isClue(value: unknown): value is CodenamesClue {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.word === "string" &&
    value.word.trim().length > 0 &&
    isNonNegativeInteger(value.count) &&
    value.count <= 9 &&
    value.intendedWords === undefined &&
    value.riskNotes === undefined
  );
}

function isMoveRecord(
  value: unknown
): value is CodenamesGameState["moveHistory"][number] {
  if (!isPlainObject(value)) return false;
  if (value.type === "clue") {
    return (
      isTeam(value.team) &&
      isClue(value.clue) &&
      isFiniteNumber(value.timestamp) &&
      (value.aiInteraction === undefined ||
        isGameAIInteraction(value.aiInteraction))
    );
  }
  if (value.type === "guess") {
    return (
      isTeam(value.team) &&
      typeof value.cardId === "string" &&
      typeof value.word === "string" &&
      isCardRole(value.role) &&
      isGuessResult(value.result) &&
      isFiniteNumber(value.timestamp) &&
      (value.aiInteraction === undefined ||
        isGameAIInteraction(value.aiInteraction))
    );
  }
  if (value.type === "end-turn") {
    return isTeam(value.team) && isFiniteNumber(value.timestamp);
  }
  return false;
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

function isAIDiagnosticAttemptArray(
  value: unknown
): value is CodenamesAIDiagnosticAttempt[] {
  return Array.isArray(value) && value.every(isAIDiagnosticAttempt);
}

function isAIDiagnosticAttempt(
  value: unknown
): value is CodenamesAIDiagnosticAttempt {
  if (!isPlainObject(value)) return false;
  return (
    isPositiveInteger(value.attempt) &&
    (value.type === "parse" ||
      value.type === "illegal" ||
      value.type === "request") &&
    typeof value.message === "string" &&
    (value.rawResponse === undefined || typeof value.rawResponse === "string")
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNormalizedConfidence(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}
