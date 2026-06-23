"use client";

import { useEffect, useRef, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { MoveRecord } from "@/lib/games/chess/types";

interface MoveHistoryProps {
  moves: MoveRecord[];
  activePly?: number;
  onSelectPly?: (ply: number) => void;
}

// Piece symbol mapping for display
const PIECE_SYMBOLS: Record<string, string> = {
  K: "♔",
  Q: "♕",
  R: "♖",
  B: "♗",
  N: "♘",
  // Pawns have no symbol in SAN notation
};

/**
 * Extract piece symbol from SAN notation
 * Returns the unicode symbol or empty string for pawns
 */
function getPieceSymbol(san: string): string {
  const firstChar = san.charAt(0);
  if (firstChar === "O") return ""; // Castling
  if (PIECE_SYMBOLS[firstChar]) {
    return PIECE_SYMBOLS[firstChar];
  }
  return ""; // Pawn move
}

/**
 * Get the move text without the piece symbol for display
 */
function getMoveText(san: string): string {
  const firstChar = san.charAt(0);
  if (firstChar === "O") return san; // Castling, keep as-is
  if (PIECE_SYMBOLS[firstChar]) {
    return san.slice(1); // Remove piece letter
  }
  return san; // Pawn move, no change
}

interface MovePairRow {
  moveNumber: number;
  whiteMove: MoveRecord | null;
  blackMove: MoveRecord | null;
}

export function MoveHistory({
  moves,
  activePly,
  onSelectPly,
}: MoveHistoryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Group moves into pairs (white + black)
  const movePairs = useMemo((): MovePairRow[] => {
    const pairs: MovePairRow[] = [];
    
    for (let i = 0; i < moves.length; i += 2) {
      const whiteMove = moves[i] || null;
      const blackMove = moves[i + 1] || null;
      const moveNumber = Math.floor(i / 2) + 1;
      
      pairs.push({ moveNumber, whiteMove, blackMove });
    }
    
    return pairs;
  }, [moves]);

  // Auto-scroll to bottom when new moves are added
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [moves.length]);

  const renderMove = (
    move: MoveRecord | null,
    isLast: boolean,
    isWhite: boolean,
    ply: number
  ) => {
    if (!move) {
      return (
        <td className="px-2 py-1.5 text-gray-400 dark:text-gray-600">—</td>
      );
    }

    const pieceSymbol = getPieceSymbol(move.san);
    const moveText = getMoveText(move.san);
    const isActiveReplayMove = activePly === ply;

    return (
      <td
        className={cn(
          "px-1 py-1 font-mono text-sm transition-colors",
          isLast && "bg-amber-100/50 dark:bg-amber-900/20",
          isActiveReplayMove && "bg-amber-200/70 dark:bg-amber-800/40",
          onSelectPly && "cursor-pointer"
        )}
        data-replay-active={isActiveReplayMove || undefined}
      >
        <button
          type="button"
          onClick={() => onSelectPly?.(ply)}
          disabled={!onSelectPly}
          className={cn(
            "inline-flex w-full items-center gap-0.5 rounded px-1 py-0.5 text-left transition-colors",
            onSelectPly && "hover:bg-gray-100 dark:hover:bg-gray-800"
          )}
          data-testid={`move-history-ply-${ply}`}
        >
          {pieceSymbol && (
            <span className={cn(
              "text-base",
              isWhite ? "text-gray-700 dark:text-gray-300" : "text-gray-600 dark:text-gray-400"
            )}>
              {pieceSymbol}
            </span>
          )}
          <span className="text-gray-800 dark:text-gray-200">
            {moveText}
          </span>
        </button>
      </td>
    );
  };

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border border-gray-200 dark:border-gray-700",
        "bg-white dark:bg-gray-900",
        "shadow-sm overflow-hidden"
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "px-4 py-2.5 border-b border-gray-200 dark:border-gray-700",
          "bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-850"
        )}
      >
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="w-4 h-4"
          >
            <path d="M12 8v4l3 3" />
            <circle cx="12" cy="12" r="9" />
          </svg>
          Move History
        </h3>
      </div>

      {/* Scrollable content */}
      <div
        ref={scrollRef}
        className={cn(
          "overflow-y-auto overflow-x-hidden",
          "max-h-[300px] min-h-[120px]",
          "scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600"
        )}
      >
        {moves.length === 0 ? (
          <div className="flex items-center justify-center h-[120px] text-gray-400 dark:text-gray-500 text-sm">
            <div className="flex flex-col items-center gap-2">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="w-8 h-8 opacity-50"
              >
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
                <rect x="9" y="3" width="6" height="4" rx="1" />
                <path d="M9 12h6M9 16h6" />
              </svg>
              <span>No moves yet</span>
            </div>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                <th className="px-2 py-1.5 text-center w-10 font-medium">#</th>
                <th className="px-2 py-1.5 text-left font-medium">White</th>
                <th className="px-2 py-1.5 text-left font-medium">Black</th>
              </tr>
            </thead>
            <tbody>
              {movePairs.map((pair, index) => {
                const isLastRow = index === movePairs.length - 1;
                const isWhiteLastMove = isLastRow && pair.blackMove === null;
                const isBlackLastMove = isLastRow && pair.blackMove !== null;

                return (
                  <tr
                    key={pair.moveNumber}
                    className="border-b border-gray-50 dark:border-gray-800/50 last:border-b-0"
                  >
                    <td className="px-2 py-1.5 text-center text-xs text-gray-400 dark:text-gray-500 font-mono">
                      {pair.moveNumber}.
                    </td>
                    {renderMove(
                      pair.whiteMove,
                      isWhiteLastMove,
                      true,
                      (pair.moveNumber - 1) * 2 + 1
                    )}
                    {renderMove(
                      pair.blackMove,
                      isBlackLastMove,
                      false,
                      (pair.moveNumber - 1) * 2 + 2
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer with move count */}
      {moves.length > 0 && (
        <div
          className={cn(
            "px-4 py-2 border-t border-gray-100 dark:border-gray-800",
            "bg-gray-50/50 dark:bg-gray-800/50",
            "text-xs text-gray-500 dark:text-gray-400"
          )}
        >
          {moves.length} move{moves.length !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

export default MoveHistory;
