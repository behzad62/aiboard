"use client";

import { Crosshair } from "lucide-react";
import type { BattleshipGameState } from "@/lib/games/battleship/types";
import { cn } from "@/lib/utils";
import { playerLabel } from "./view-helpers";

export function BattleshipMoveHistory({
  state,
}: {
  state: BattleshipGameState;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 font-semibold">
          <Crosshair className="h-4 w-4" aria-hidden="true" />
          Shots
        </div>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {state.moveHistory.length}
        </span>
      </div>
      <div className="max-h-72 overflow-auto">
        {state.moveHistory.length === 0 ? (
          <div className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">
            No shots yet.
          </div>
        ) : (
          <ol className="divide-y divide-slate-100 dark:divide-slate-800">
            {state.moveHistory.map((move, index) => (
              <li
                key={`${move.player}-${move.displayTarget}-${index}`}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="w-6 text-xs font-semibold text-slate-400">
                    {index + 1}.
                  </span>
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      move.player === "blue" ? "bg-sky-500" : "bg-orange-500"
                    )}
                    aria-hidden="true"
                  />
                  <span className="font-medium">{playerLabel(move.player)}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                    {move.displayTarget}
                  </span>
                  <span
                    className={cn(
                      "rounded-md px-2 py-1 text-xs font-bold",
                      move.result === "miss" &&
                        "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
                      move.result === "hit" &&
                        "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200",
                      move.result === "sunk" &&
                        "bg-red-600 text-white dark:bg-red-500"
                    )}
                  >
                    {move.result}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
