"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  QUORIDOR_SIZE,
  QUORIDOR_WALL_GRID,
  formatQuoridorSquare,
  getLegalActions,
} from "@/lib/games/quoridor/engine";
import type {
  QuoridorGameState,
  QuoridorPlayer,
  QuoridorWall,
  QuoridorWallOrientation,
} from "@/lib/games/quoridor/types";

export type QuoridorActionMode = "move" | "wall";

interface QuoridorBoardProps {
  state: QuoridorGameState;
  interactive: boolean;
  actionMode: QuoridorActionMode;
  wallOrientation: QuoridorWallOrientation;
  onActionModeChange: (mode: QuoridorActionMode) => void;
  onWallOrientationChange: (orientation: QuoridorWallOrientation) => void;
  onMove: (row: number, col: number) => void;
  onPlaceWall: (row: number, col: number, orientation: QuoridorWallOrientation) => void;
}

function wallCoversVertical(
  walls: QuoridorWall[],
  row: number,
  colBetween: number
): boolean {
  return walls.some(
    (wall) =>
      wall.orientation === "V" &&
      wall.col === colBetween &&
      (wall.row === row || wall.row === row - 1)
  );
}

function wallCoversHorizontal(
  walls: QuoridorWall[],
  rowBetween: number,
  col: number
): boolean {
  return walls.some(
    (wall) =>
      wall.orientation === "H" &&
      wall.row === rowBetween &&
      (wall.col === col || wall.col === col - 1)
  );
}

export function QuoridorBoard({
  state,
  interactive,
  actionMode,
  wallOrientation,
  onActionModeChange,
  onWallOrientationChange,
  onMove,
  onPlaceWall,
}: QuoridorBoardProps) {
  const legalActions = useMemo(() => getLegalActions(state), [state]);
  const legalMoves = useMemo(() => {
    const set = new Set<string>();
    for (const action of legalActions) {
      if (action.type === "move") set.add(`${action.row},${action.col}`);
    }
    return set;
  }, [legalActions]);
  const legalWalls = useMemo(() => {
    const set = new Set<string>();
    for (const action of legalActions) {
      if (action.type === "wall") {
        set.add(`${action.row},${action.col},${action.orientation}`);
      }
    }
    return set;
  }, [legalActions]);

  const tracks = Array.from({ length: QUORIDOR_SIZE * 2 - 1 }, (_, index) =>
    index % 2 === 0 ? "minmax(28px, 1fr)" : "14px"
  );

  return (
    <div className="w-full max-w-[640px]" data-testid="quoridor-board">
      <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
        <ModeButton
          label="Move pawn"
          testId="quoridor-mode-move"
          selected={actionMode === "move"}
          onClick={() => onActionModeChange("move")}
          disabled={!interactive}
        />
        <ModeButton
          label="Place wall"
          testId="quoridor-mode-wall"
          selected={actionMode === "wall"}
          onClick={() => onActionModeChange("wall")}
          disabled={!interactive}
        />
        {actionMode === "wall" && (
          <>
            <ModeButton
              label="Horizontal"
              testId="quoridor-orientation-H"
              selected={wallOrientation === "H"}
              onClick={() => onWallOrientationChange("H")}
              disabled={!interactive}
            />
            <ModeButton
              label="Vertical"
              testId="quoridor-orientation-V"
              selected={wallOrientation === "V"}
              onClick={() => onWallOrientationChange("V")}
              disabled={!interactive}
            />
          </>
        )}
      </div>

      <div
        className={cn(
          "rounded-2xl border border-amber-900/40 bg-amber-200 p-3",
          "shadow-[0_22px_55px_rgba(120,53,15,0.28)] dark:border-amber-600/30 dark:bg-amber-900/80"
        )}
        role="grid"
        aria-label="Quoridor board"
      >
        <div
          className="grid"
          style={{
            gridTemplateColumns: tracks.join(" "),
            gridTemplateRows: tracks.join(" "),
          }}
        >
          {Array.from({ length: QUORIDOR_SIZE * 2 - 1 }, (_, gridRow) =>
            Array.from({ length: QUORIDOR_SIZE * 2 - 1 }, (_, gridCol) => {
              const squareRow = gridRow / 2;
              const squareCol = gridCol / 2;
              const isSquare = gridRow % 2 === 0 && gridCol % 2 === 0;
              const isIntersection = gridRow % 2 === 1 && gridCol % 2 === 1;
              const isVerticalGap = gridRow % 2 === 0 && gridCol % 2 === 1;
              const isHorizontalGap = gridRow % 2 === 1 && gridCol % 2 === 0;

              if (isSquare) {
                const row = squareRow;
                const col = squareCol;
                const occupant = occupantAt(state, row, col);
                const canMove =
                  interactive &&
                  actionMode === "move" &&
                  legalMoves.has(`${row},${col}`);

                return (
                  <button
                    key={`${gridRow}-${gridCol}`}
                    type="button"
                    className={cn(
                      "relative aspect-square rounded-sm border border-amber-900/25 bg-amber-50",
                      "dark:border-amber-700/40 dark:bg-amber-950/40",
                      canMove &&
                        "cursor-pointer ring-2 ring-emerald-400 ring-offset-1 ring-offset-amber-200",
                      !canMove && "cursor-default"
                    )}
                    disabled={!canMove}
                    onClick={() => {
                      if (canMove) onMove(row, col);
                    }}
                    role="gridcell"
                    aria-label={`${formatQuoridorSquare({ row, col })}${
                      occupant ? `, ${occupant} pawn` : ""
                    }`}
                    data-testid={`quoridor-square-${row}-${col}`}
                  >
                    {occupant && <Pawn player={occupant} />}
                  </button>
                );
              }

              if (isVerticalGap) {
                const row = gridRow / 2;
                const colBetween = (gridCol - 1) / 2;
                const filled = wallCoversVertical(state.walls, row, colBetween);
                return (
                  <div
                    key={`${gridRow}-${gridCol}`}
                    className={cn(
                      "m-[1px] rounded-sm",
                      filled
                        ? "bg-amber-950 dark:bg-amber-200"
                        : "bg-amber-300/70 dark:bg-amber-800/80"
                    )}
                    aria-hidden="true"
                  />
                );
              }

              if (isHorizontalGap) {
                const rowBetween = (gridRow - 1) / 2;
                const col = gridCol / 2;
                const filled = wallCoversHorizontal(
                  state.walls,
                  rowBetween,
                  col
                );
                return (
                  <div
                    key={`${gridRow}-${gridCol}`}
                    className={cn(
                      "m-[1px] rounded-sm",
                      filled
                        ? "bg-amber-950 dark:bg-amber-200"
                        : "bg-amber-300/70 dark:bg-amber-800/80"
                    )}
                    aria-hidden="true"
                  />
                );
              }

              if (isIntersection) {
                const wallRow = (gridRow - 1) / 2;
                const wallCol = (gridCol - 1) / 2;
                const canPlace =
                  interactive &&
                  actionMode === "wall" &&
                  wallRow < QUORIDOR_WALL_GRID &&
                  wallCol < QUORIDOR_WALL_GRID &&
                  legalWalls.has(
                    `${wallRow},${wallCol},${wallOrientation}`
                  );

                return (
                  <button
                    key={`${gridRow}-${gridCol}`}
                    type="button"
                    className={cn(
                      "m-[1px] rounded-sm bg-amber-400/80 dark:bg-amber-700",
                      canPlace &&
                        "cursor-pointer ring-2 ring-sky-400 ring-offset-1 ring-offset-amber-200",
                      !canPlace && "cursor-default"
                    )}
                    disabled={!canPlace}
                    onClick={() => {
                      if (canPlace) {
                        onPlaceWall(wallRow, wallCol, wallOrientation);
                      }
                    }}
                    aria-label={`Wall intersection ${formatQuoridorSquare({
                      row: wallRow,
                      col: wallCol,
                    })}`}
                    data-testid={`quoridor-wall-${wallRow}-${wallCol}`}
                  />
                );
              }

              return <div key={`${gridRow}-${gridCol}`} />;
            })
          )}
        </div>
      </div>
    </div>
  );
}

function occupantAt(
  state: QuoridorGameState,
  row: number,
  col: number
): QuoridorPlayer | null {
  if (state.pawns.south.row === row && state.pawns.south.col === col) {
    return "south";
  }
  if (state.pawns.north.row === row && state.pawns.north.col === col) {
    return "north";
  }
  return null;
}

function Pawn({ player }: { player: QuoridorPlayer }) {
  return (
    <span
      className={cn(
        "absolute inset-1 rounded-full border-2 shadow-md",
        player === "south"
          ? "border-orange-900 bg-gradient-to-br from-orange-200 via-orange-400 to-orange-800"
          : "border-sky-950 bg-gradient-to-br from-sky-200 via-sky-600 to-slate-900"
      )}
      aria-hidden="true"
    />
  );
}

function ModeButton({
  label,
  selected,
  onClick,
  disabled,
  testId,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "rounded-lg border px-3 py-1.5 text-sm font-semibold transition",
        selected
          ? "border-amber-700 bg-amber-800 text-amber-50"
          : "border-amber-300 bg-white text-amber-900 hover:bg-amber-50 dark:border-amber-800 dark:bg-slate-950 dark:text-amber-100",
        disabled && "cursor-not-allowed opacity-60"
      )}
      aria-pressed={selected}
    >
      {label}
    </button>
  );
}

export default QuoridorBoard;
