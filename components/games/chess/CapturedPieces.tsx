"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { ChessPiece } from "@/components/games/pieces";
import type { Piece, PieceColor, PieceType } from "@/lib/games/chess/types";

interface CapturedPiecesProps {
  player: PieceColor;
  pieces: Piece[];
  className?: string;
}

const PIECE_ORDER: Record<PieceType, number> = {
  queen: 0,
  rook: 1,
  bishop: 2,
  knight: 3,
  pawn: 4,
  king: 5,
};

export function CapturedPieces({
  player,
  pieces,
  className,
}: CapturedPiecesProps) {
  const sortedPieces = useMemo(
    () =>
      [...pieces].sort((a, b) => {
        const byValue = PIECE_ORDER[a.type] - PIECE_ORDER[b.type];
        return byValue !== 0 ? byValue : a.color.localeCompare(b.color);
      }),
    [pieces]
  );

  const label = player === "white" ? "White captured" : "Black captured";

  return (
    <aside
      className={cn(
        "flex min-h-24 flex-col rounded-xl border px-3 py-3 shadow-sm",
        "border-slate-200 bg-white/90 text-slate-900",
        "dark:border-slate-700 dark:bg-slate-900/75 dark:text-slate-100",
        className
      )}
      data-testid={`captured-${player}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {label}
        </span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
          {pieces.length}
        </span>
      </div>

      <div className="mt-2 flex min-h-12 flex-wrap content-start items-center gap-1.5">
        {sortedPieces.length === 0 ? (
          <span className="text-sm text-slate-400 dark:text-slate-500">
            No captures
          </span>
        ) : (
          sortedPieces.map((piece, index) => (
            <span
              key={`${piece.color}-${piece.type}-${index}`}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-md border",
                "border-slate-200 bg-slate-50 shadow-inner",
                "dark:border-slate-700 dark:bg-slate-800"
              )}
              data-testid={`captured-${player}-${piece.color}-${piece.type}`}
              title={`${piece.color} ${piece.type}`}
            >
              <ChessPiece piece={piece} size={26} />
            </span>
          ))
        )}
      </div>
    </aside>
  );
}

export default CapturedPieces;
