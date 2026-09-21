import {
  QUORIDOR_ACTIVE_SESSION_ID,
  parseQuoridorSessionRecord,
  type QuoridorSessionSnapshot,
} from "@/lib/games/quoridor/session";
import type { QuoridorGameState } from "@/lib/games/quoridor/types";
import type { GameExport, GameSessionRecord } from "@/lib/games/core/types";

export type QuoridorJsonImportResult =
  | { ok: true; snapshot: QuoridorSessionSnapshot }
  | { ok: false; error: string };

export function exportQuoridorMoveList(state: QuoridorGameState): GameExport {
  return {
    filename: "ai-board-quoridor-moves.txt",
    mimeType: "text/plain",
    content:
      state.moveHistory.length === 0
        ? "(no moves)"
        : state.moveHistory.map(formatMoveRecord).join("\n"),
  };
}

export function exportQuoridorJson(
  snapshot: QuoridorSessionSnapshot
): GameExport {
  return {
    filename: "ai-board-quoridor.json",
    mimeType: "application/json",
    content: JSON.stringify({
      export: {
        game: "quoridor",
        format: "ai-board-quoridor-json",
        version: 1,
        generatedAt: new Date().toISOString(),
      },
      snapshot,
    }),
  };
}

export function parseQuoridorJsonExport(
  content: string
): QuoridorJsonImportResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: "The selected file is not valid JSON." };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: "The selected file is not a Quoridor export.",
    };
  }

  const descriptor = parsed.export;
  if (
    !isPlainObject(descriptor) ||
    descriptor.game !== "quoridor" ||
    descriptor.format !== "ai-board-quoridor-json" ||
    descriptor.version !== 1
  ) {
    return {
      ok: false,
      error: "The selected file is not an AI Board Quoridor JSON export.",
    };
  }

  if (!isPlainObject(parsed.snapshot)) {
    return {
      ok: false,
      error: "The Quoridor export is missing its snapshot.",
    };
  }

  const now = new Date().toISOString();
  const record: GameSessionRecord = {
    id: QUORIDOR_ACTIVE_SESSION_ID,
    gameId: "quoridor",
    title: "Quoridor: Imported Game",
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
  const snapshot = parseQuoridorSessionRecord(record);

  if (!snapshot) {
    return {
      ok: false,
      error: "The Quoridor export snapshot is incomplete or unsupported.",
    };
  }

  return { ok: true, snapshot };
}

function formatMoveRecord(
  move: QuoridorGameState["moveHistory"][number],
  index: number
): string {
  return `${index + 1}. ${move.player === "south" ? "South" : "North"}: ${
    move.notation
  }`;
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
