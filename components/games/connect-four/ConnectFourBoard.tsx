"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  CONNECT_FOUR_COLUMNS,
  CONNECT_FOUR_ROWS,
  getLegalColumns,
} from "@/lib/games/connect-four/engine";
import type {
  ConnectFourCell,
  ConnectFourGameState,
} from "@/lib/games/connect-four/types";

interface ConnectFourBoardProps {
  state: ConnectFourGameState;
  interactive: boolean;
  onColumnClick?: (column: number) => void;
  previewColumn?: number | null;
  onPreviewColumn?: (column: number | null) => void;
}

const PLAYER_LABELS: Record<Exclude<ConnectFourCell, null>, string> = {
  red: "Red",
  yellow: "Yellow",
};

export function ConnectFourBoard({
  state,
  interactive,
  onColumnClick,
  previewColumn = null,
  onPreviewColumn,
}: ConnectFourBoardProps) {
  const legalColumns = useMemo(() => new Set(getLegalColumns(state)), [state]);

  return (
    <div
      className={cn(
        "w-full max-w-[640px] rounded-2xl border border-sky-950/30 bg-sky-700 p-3",
        "shadow-[0_22px_55px_rgba(7,89,133,0.35)] dark:border-sky-400/20 dark:bg-sky-800"
      )}
      data-testid="connect-four-board"
      role="grid"
      aria-label="Connect Four board"
      style={{
        gridTemplateColumns: `repeat(${CONNECT_FOUR_COLUMNS}, minmax(0, 1fr))`,
      }}
    >
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(${CONNECT_FOUR_COLUMNS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${CONNECT_FOUR_ROWS}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: CONNECT_FOUR_ROWS }, (_, row) =>
          Array.from({ length: CONNECT_FOUR_COLUMNS }, (_, column) => {
            const cell = state.board[row][column];
            const canPlay = interactive && legalColumns.has(column);
            const isPreviewed = previewColumn === column && canPlay;
            const cellLabel = cell ? `${PLAYER_LABELS[cell]} disc` : "empty";

            return (
              <button
                key={`${row}-${column}`}
                type="button"
                className={cn(
                  "group relative aspect-square rounded-full border-[5px] border-sky-950/55 bg-sky-950/35 p-1",
                  "shadow-[inset_0_3px_8px_rgba(8,47,73,0.55)] transition duration-150",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300",
                  canPlay && "cursor-pointer hover:-translate-y-0.5 hover:border-white/70 hover:bg-sky-950/20",
                  !canPlay && "cursor-default",
                  isPreviewed && "ring-2 ring-amber-200 ring-offset-2 ring-offset-sky-700"
                )}
                disabled={!canPlay}
                onClick={() => {
                  if (canPlay) onColumnClick?.(column);
                }}
                onFocus={() => {
                  if (canPlay) onPreviewColumn?.(column);
                }}
                onBlur={() => {
                  if (canPlay) onPreviewColumn?.(null);
                }}
                onMouseEnter={() => {
                  if (canPlay) onPreviewColumn?.(column);
                }}
                onMouseLeave={() => {
                  if (canPlay) onPreviewColumn?.(null);
                }}
                role="gridcell"
                aria-label={`Column ${column + 1}, row ${row + 1}, ${cellLabel}`}
                data-testid={`connect-four-cell-${row}-${column}`}
              >
                <span
                  className={cn(
                    "block h-full w-full rounded-full transition duration-150",
                    "shadow-[inset_0_5px_10px_rgba(255,255,255,0.28),inset_0_-8px_14px_rgba(15,23,42,0.22)]",
                    cell === "red" &&
                      "bg-gradient-to-br from-red-300 via-red-500 to-red-800",
                    cell === "yellow" &&
                      "bg-gradient-to-br from-yellow-100 via-amber-300 to-yellow-600",
                    cell === null &&
                      cn(
                        "bg-slate-950/45",
                        canPlay && "group-hover:bg-slate-900/35",
                        isPreviewed && "bg-amber-100/35"
                      )
                  )}
                  aria-hidden="true"
                />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

export default ConnectFourBoard;
