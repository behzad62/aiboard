import { toFEN } from "@/lib/games/chess/engine";
import type { ChessSessionSnapshot } from "@/lib/games/chess/session";
import type { GameState, MoveRecord } from "@/lib/games/chess/types";
import type { GameExport } from "@/lib/games/core/types";

export type ChessPgnResult = "1-0" | "0-1" | "1/2-1/2" | "*";

export interface ChessPgnMetadata {
  date?: Date | string;
  result?: ChessPgnResult;
  white?: string;
  black?: string;
}

export function exportChessMoveList(state: GameState): GameExport {
  return {
    filename: "ai-board-chess-moves.txt",
    mimeType: "text/plain",
    content: formatSanMoveText(state.moveHistory),
  };
}

export function exportChessFenList(state: GameState): GameExport {
  const initialFen = state.moveHistory[0]?.fenBefore ?? toFEN(state);
  const lines = [`Initial FEN: ${initialFen}`];

  for (let i = 0; i < state.moveHistory.length; i++) {
    const move = state.moveHistory[i];
    lines.push(`After ${formatMoveLabel(i, move)}: ${move.fenAfter}`);
  }

  lines.push(`Current FEN: ${toFEN(state)}`);

  return {
    filename: "ai-board-chess-fens.txt",
    mimeType: "text/plain",
    content: lines.join("\n"),
  };
}

export function exportChessJson(
  snapshot: ChessSessionSnapshot
): GameExport {
  return {
    filename: "ai-board-chess.json",
    mimeType: "application/json",
    content: JSON.stringify({
      export: {
        game: "chess",
        format: "json",
        version: 1,
        generatedAt: new Date().toISOString(),
      },
      snapshot,
    }),
  };
}

export function exportChessPgnLike(
  state: GameState,
  metadata: ChessPgnMetadata = {}
): GameExport {
  const result = metadata.result ?? resultFromState(state);
  const tags = [
    ["Event", "AI Board Chess"],
    ["Site", "AI Board"],
    ["Date", formatPgnDate(metadata.date)],
    ["Result", result],
  ];

  if (metadata.white) tags.push(["White", metadata.white]);
  if (metadata.black) tags.push(["Black", metadata.black]);

  const tagText = tags
    .map(([name, value]) => `[${name} "${escapePgnTagValue(value)}"]`)
    .join("\n");
  const moves = formatSanMoveText(state.moveHistory, result);

  return {
    filename: "ai-board-chess.pgn",
    mimeType: "text/plain",
    content: `${tagText}\n\n${moves}`,
  };
}

function formatSanMoveText(
  moveHistory: MoveRecord[],
  result?: ChessPgnResult
): string {
  const parts: string[] = [];

  for (let i = 0; i < moveHistory.length; i++) {
    const moveNumber = Math.floor(i / 2) + 1;
    const san = moveHistory[i].san;

    if (i % 2 === 0) {
      parts.push(`${moveNumber}. ${san}`);
    } else {
      parts[parts.length - 1] = `${parts[parts.length - 1]} ${san}`;
    }
  }

  if (result) parts.push(result);

  return parts.join(" ");
}

function formatMoveLabel(index: number, move: MoveRecord): string {
  const moveNumber = Math.floor(index / 2) + 1;
  return index % 2 === 0
    ? `${moveNumber}. ${move.san}`
    : `${moveNumber}... ${move.san}`;
}

function resultFromState(state: GameState): ChessPgnResult {
  if (state.status === "checkmate" && state.winner === "white") return "1-0";
  if (state.status === "checkmate" && state.winner === "black") return "0-1";
  if (state.status === "draw" || state.status === "stalemate") {
    return "1/2-1/2";
  }
  return "*";
}

function formatPgnDate(value: Date | string | undefined): string {
  if (typeof value === "string" && /^\d{4}\.\d{2}\.\d{2}$/.test(value)) {
    return value;
  }

  const date =
    value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return "????.??.??";
  }

  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}.${month}.${day}`;
}

function escapePgnTagValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
