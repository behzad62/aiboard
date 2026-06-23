import {
  CONNECT_FOUR_ACTIVE_SESSION_ID,
  parseConnectFourSessionRecord,
  type ConnectFourSessionSnapshot,
} from "@/lib/games/connect-four/session";
import type { ConnectFourGameState } from "@/lib/games/connect-four/types";
import type { GameExport, GameSessionRecord } from "@/lib/games/core/types";

export type ConnectFourJsonImportResult =
  | { ok: true; snapshot: ConnectFourSessionSnapshot }
  | { ok: false; error: string };

export function exportConnectFourMoveList(
  state: ConnectFourGameState
): GameExport {
  return {
    filename: "ai-board-connect-four-moves.txt",
    mimeType: "text/plain",
    content:
      state.moveHistory.length === 0
        ? "(no moves)"
        : state.moveHistory.map(formatMoveRecord).join("\n"),
  };
}

export function exportConnectFourJson(
  snapshot: ConnectFourSessionSnapshot
): GameExport {
  return {
    filename: "ai-board-connect-four.json",
    mimeType: "application/json",
    content: JSON.stringify({
      app: "AI Board",
      format: "json",
      game: "connect-four",
      version: 1,
      exportedAt: new Date().toISOString(),
      snapshot,
    }),
  };
}

export function parseConnectFourJsonExport(
  content: string
): ConnectFourJsonImportResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: "The selected file is not valid JSON." };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: "The selected file is not a Connect Four export.",
    };
  }

  if (
    parsed.app !== "AI Board" ||
    parsed.format !== "json" ||
    parsed.game !== "connect-four" ||
    parsed.version !== 1
  ) {
    return {
      ok: false,
      error: "The selected file is not an AI Board Connect Four JSON export.",
    };
  }

  if (!isPlainObject(parsed.snapshot)) {
    return {
      ok: false,
      error: "The Connect Four export is missing its snapshot.",
    };
  }

  const now = new Date().toISOString();
  const record: GameSessionRecord = {
    id: CONNECT_FOUR_ACTIVE_SESSION_ID,
    gameId: "connect-four",
    title: "Connect Four: Imported Game",
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
  const snapshot = parseConnectFourSessionRecord(record);

  if (!snapshot) {
    return {
      ok: false,
      error: "The Connect Four export snapshot is incomplete or unsupported.",
    };
  }

  return { ok: true, snapshot };
}

function formatMoveRecord(
  move: ConnectFourGameState["moveHistory"][number],
  index: number
): string {
  return `${index + 1}. ${move.player === "red" ? "Red" : "Yellow"}: ${
    move.displayColumn
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
