import {
  BATTLESHIP_ACTIVE_SESSION_ID,
  parseBattleshipSessionRecord,
  type BattleshipSessionSnapshot,
} from "@/lib/games/battleship/session";
import type { BattleshipGameState } from "@/lib/games/battleship/types";
import type { GameExport, GameSessionRecord } from "@/lib/games/core/types";

export type BattleshipJsonImportResult =
  | { ok: true; snapshot: BattleshipSessionSnapshot }
  | { ok: false; error: string };

export function exportBattleshipMoveList(
  state: BattleshipGameState
): GameExport {
  return {
    filename: "ai-board-battleship-moves.txt",
    mimeType: "text/plain",
    content:
      state.moveHistory.length === 0
        ? "(no moves)"
        : state.moveHistory.map(formatMoveRecord).join("\n"),
  };
}

export function exportBattleshipJson(
  snapshot: BattleshipSessionSnapshot
): GameExport {
  return {
    filename: "ai-board-battleship.json",
    mimeType: "application/json",
    content: JSON.stringify({
      export: {
        game: "battleship",
        format: "ai-board-battleship-json",
        version: 1,
        generatedAt: new Date().toISOString(),
      },
      snapshot,
    }),
  };
}

export function parseBattleshipJsonExport(
  content: string
): BattleshipJsonImportResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: "The selected file is not valid JSON." };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: "The selected file is not a Battleship export.",
    };
  }

  const descriptor = parsed.export;
  if (
    !isPlainObject(descriptor) ||
    descriptor.game !== "battleship" ||
    descriptor.format !== "ai-board-battleship-json" ||
    descriptor.version !== 1
  ) {
    return {
      ok: false,
      error: "The selected file is not an AI Board Battleship JSON export.",
    };
  }

  if (!isPlainObject(parsed.snapshot)) {
    return {
      ok: false,
      error: "The Battleship export is missing its snapshot.",
    };
  }

  const now = new Date().toISOString();
  const record: GameSessionRecord = {
    id: BATTLESHIP_ACTIVE_SESSION_ID,
    gameId: "battleship",
    title: "Battleship: Imported Game",
    status: "active",
    participants: [],
    stateJson: JSON.stringify(parsed.snapshot),
    metadataJson: JSON.stringify({
      version: 1,
      savedAt: now,
      moves: exportedMoveCount(parsed.snapshot),
    }),
    createdAt: now,
    updatedAt: now,
  };
  const snapshot = parseBattleshipSessionRecord(record);

  if (!snapshot) {
    return {
      ok: false,
      error: "The Battleship export snapshot is incomplete or unsupported.",
    };
  }

  return { ok: true, snapshot };
}

function formatMoveRecord(
  move: BattleshipGameState["moveHistory"][number],
  index: number
): string {
  const player = move.player === "blue" ? "Blue" : "Orange";
  return `${index + 1}. ${player} ${move.displayTarget} ${move.result}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exportedMoveCount(snapshot: Record<string, unknown>): number {
  const gameState = snapshot.gameState;
  if (!isPlainObject(gameState) || !Array.isArray(gameState.moveHistory)) {
    return 0;
  }

  return gameState.moveHistory.length;
}
