"use client";

import { Crosshair, Ship } from "lucide-react";
import {
  BATTLESHIP_BOARD_SIZE,
  isLegalBattleshipTarget,
  targetToLabel,
} from "@/lib/games/battleship/engine";
import type {
  BattleshipCoordinate,
  BattleshipGameState,
  BattleshipPlayer,
  BattleshipPlayerBoard,
  BattleshipShip,
  BattleshipShotRecord,
} from "@/lib/games/battleship/types";
import { cn } from "@/lib/utils";
import { playerLabel } from "./view-helpers";

interface BattleshipGridProps {
  title: string;
  subtitle: string;
  player: BattleshipPlayer;
  board: BattleshipPlayerBoard;
  revealShips: boolean;
  interactive: boolean;
  attacker?: BattleshipPlayer;
  state?: BattleshipGameState;
  onCellClick?: (target: BattleshipCoordinate) => void;
}

export function BattleshipGrid({
  title,
  subtitle,
  player,
  board,
  revealShips,
  interactive,
  attacker,
  state,
  onCellClick,
}: BattleshipGridProps) {
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-xl dark:border-slate-800 dark:bg-slate-950/90"
      data-testid={`battleship-grid-${subtitle.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{title}</h2>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {subtitle}
          </p>
        </div>
        <div
          className={cn(
            "rounded-full px-3 py-1 text-xs font-semibold",
            player === "blue"
              ? "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200"
              : "bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200"
          )}
        >
          {playerLabel(player)}
        </div>
      </div>

      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-1">
        <div />
        <div
          className="grid gap-1 text-center text-[11px] font-semibold text-slate-500"
          style={{
            gridTemplateColumns: `repeat(${BATTLESHIP_BOARD_SIZE}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: BATTLESHIP_BOARD_SIZE }, (_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>

        {Array.from({ length: BATTLESHIP_BOARD_SIZE }, (_, row) => (
          <RowFragment
            key={row}
            row={row}
            board={board}
            revealShips={revealShips}
            interactive={interactive}
            attacker={attacker}
            state={state}
            onCellClick={onCellClick}
          />
        ))}
      </div>
    </section>
  );
}

function RowFragment({
  row,
  board,
  revealShips,
  interactive,
  attacker,
  state,
  onCellClick,
}: {
  row: number;
  board: BattleshipPlayerBoard;
  revealShips: boolean;
  interactive: boolean;
  attacker?: BattleshipPlayer;
  state?: BattleshipGameState;
  onCellClick?: (target: BattleshipCoordinate) => void;
}) {
  const rowLabel = String.fromCharCode(65 + row);

  return (
    <>
      <div className="flex items-center justify-center text-xs font-semibold text-slate-500">
        {rowLabel}
      </div>
      <div
        className="grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${BATTLESHIP_BOARD_SIZE}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: BATTLESHIP_BOARD_SIZE }, (_, column) => {
          const target = { row, column };
          const ship = shipAtCell(board, target);
          const shot = shotAtCell(board, target);
          const legal =
            interactive &&
            state &&
            attacker &&
            isLegalBattleshipTarget(state, attacker, target);

          return (
            <button
              key={`${row}:${column}`}
              type="button"
              onClick={() => {
                if (legal) onCellClick?.(target);
              }}
              disabled={!legal}
              className={cn(
                "relative aspect-square min-h-8 overflow-hidden rounded-md border text-[10px] font-bold transition",
                "border-sky-900/20 bg-sky-100 shadow-inner dark:border-sky-400/20 dark:bg-sky-950",
                revealShips &&
                  ship &&
                  "bg-slate-300 dark:bg-slate-700 dark:text-slate-100",
                shot?.result === "miss" &&
                  "bg-slate-100 text-slate-500 dark:bg-slate-900 dark:text-slate-400",
                (shot?.result === "hit" || shot?.result === "sunk") &&
                  "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200",
                shot?.result === "sunk" && "ring-2 ring-red-500",
                legal &&
                  "cursor-crosshair hover:-translate-y-0.5 hover:bg-sky-200 hover:ring-2 hover:ring-sky-400 dark:hover:bg-sky-900"
              )}
              data-testid={`battleship-cell-${targetToLabel(target)}`}
              aria-label={targetToLabel(target)}
            >
              {shot?.result === "miss" && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="h-3 w-3 rounded-full border-2 border-sky-600 bg-white/80 shadow-[0_0_0_4px_rgba(14,165,233,0.18)] dark:border-sky-300 dark:bg-sky-100" />
                </span>
              )}
              {shot?.result === "hit" && (
                <span className="absolute inset-0 flex items-center justify-center bg-red-500/15">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[11px] font-black text-white shadow-[0_0_0_5px_rgba(220,38,38,0.18)]">
                    X
                  </span>
                </span>
              )}
              {shot?.result === "sunk" && (
                <span className="absolute inset-0 flex items-center justify-center bg-red-700">
                  <span className="text-[9px] font-black uppercase tracking-wide text-white">
                    Sunk
                  </span>
                </span>
              )}
              {!shot && revealShips && ship && (
                <Ship className="mx-auto h-3.5 w-3.5" aria-hidden="true" />
              )}
              {!shot && legal && (
                <Crosshair
                  className="mx-auto h-3.5 w-3.5 opacity-0 transition hover:opacity-100"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

function shipAtCell(
  board: BattleshipPlayerBoard,
  target: BattleshipCoordinate
): BattleshipShip | null {
  return (
    board.ships.find((ship) =>
      ship.cells.some(
        (cell) => cell.row === target.row && cell.column === target.column
      )
    ) ?? null
  );
}

function shotAtCell(
  board: BattleshipPlayerBoard,
  target: BattleshipCoordinate
): BattleshipShotRecord | null {
  return (
    board.shotsReceived.find(
      (shot) =>
        shot.target.row === target.row && shot.target.column === target.column
    ) ?? null
  );
}
