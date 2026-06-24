import {
  CODENAMES_ACTIVE_SESSION_ID,
  parseCodenamesSessionRecord,
  type CodenamesSessionSnapshot,
} from "@/lib/games/codenames/session";
import type { CodenamesGameState, CodenamesTeam } from "@/lib/games/codenames/types";
import type { GameExport, GameSessionRecord } from "@/lib/games/core/types";

export type CodenamesJsonImportResult =
  | { ok: true; snapshot: CodenamesSessionSnapshot }
  | { ok: false; error: string };

export function exportCodenamesMoveList(state: CodenamesGameState): GameExport {
  return {
    filename: "ai-board-codenames-moves.txt",
    mimeType: "text/plain",
    content:
      state.moveHistory.length === 0
        ? "(no moves)"
        : state.moveHistory.map(formatMoveRecord).join("\n"),
  };
}

export function exportCodenamesJson(snapshot: CodenamesSessionSnapshot): GameExport {
  return {
    filename: "ai-board-codenames.json",
    mimeType: "application/json",
    content: JSON.stringify({
      export: {
        game: "codenames",
        format: "ai-board-codenames-json",
        version: 1,
        generatedAt: new Date().toISOString(),
      },
      snapshot,
    }),
  };
}

export function parseCodenamesJsonExport(content: string): CodenamesJsonImportResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: "The selected file is not valid JSON." };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: "The selected file is not a Codenames export.",
    };
  }

  const descriptor = parsed.export;
  if (
    !isPlainObject(descriptor) ||
    descriptor.game !== "codenames" ||
    descriptor.format !== "ai-board-codenames-json" ||
    descriptor.version !== 1
  ) {
    return {
      ok: false,
      error: "The selected file is not an AI Board Codenames JSON export.",
    };
  }

  if (!isPlainObject(parsed.snapshot)) {
    return {
      ok: false,
      error: "The Codenames export is missing its snapshot.",
    };
  }

  const now = new Date().toISOString();
  const record: GameSessionRecord = {
    id: CODENAMES_ACTIVE_SESSION_ID,
    gameId: "codenames",
    title: "Codenames: Imported Game",
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
  const snapshot = parseCodenamesSessionRecord(record);

  if (!snapshot) {
    return {
      ok: false,
      error: "The Codenames export snapshot is incomplete or unsupported.",
    };
  }

  return { ok: true, snapshot };
}

function formatMoveRecord(
  move: CodenamesGameState["moveHistory"][number],
  index: number
): string {
  if (move.type === "clue") {
    return `${index + 1}. ${teamLabel(move.team)} clue: ${move.clue.word} ${
      move.clue.count
    }`;
  }
  if (move.type === "guess") {
    return `${index + 1}. ${teamLabel(move.team)} guess: ${move.word} ${move.result}`;
  }
  return `${index + 1}. ${teamLabel(move.team)} ended turn`;
}

function teamLabel(team: CodenamesTeam): string {
  return team === "red" ? "Red" : "Blue";
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
