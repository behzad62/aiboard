"use client";

import { Bot, User } from "lucide-react";
import { GameAIPresence } from "@/components/games/GameAIPresence";
import { buildGameAIThinkingInteraction } from "@/lib/games/core/ai-interactions";
import type { GameAIInteraction } from "@/lib/games/core/types";
import type {
  BattleshipPlayer,
  BattleshipPlayerBoard,
} from "@/lib/games/battleship/types";
import { cn } from "@/lib/utils";
import {
  playerLabel,
  remainingShipCells,
  sunkShipCount,
} from "./view-helpers";

interface BattleshipPlayerCardProps {
  player: BattleshipPlayer;
  active: boolean;
  isAI: boolean;
  modelName?: string;
  reasoning?: string;
  board: BattleshipPlayerBoard;
  aiInteraction?: GameAIInteraction | null;
  aiThinking?: boolean;
}

export function BattleshipPlayerCard({
  player,
  active,
  isAI,
  modelName,
  reasoning,
  board,
  aiInteraction = null,
  aiThinking = false,
}: BattleshipPlayerCardProps) {
  const remaining = remainingShipCells(board);
  const sunk = sunkShipCount(board);
  const visibleInteraction =
    isAI
      ? aiThinking
        ? buildGameAIThinkingInteraction(player)
        : aiInteraction
      : null;

  return (
    <section
      data-testid={`battleship-player-${player}`}
      className={cn(
        "rounded-xl border bg-white p-4 shadow-sm dark:bg-slate-950",
        player === "blue"
          ? "border-sky-200 dark:border-sky-900/70"
          : "border-orange-200 dark:border-orange-900/70",
        active &&
          (player === "blue"
            ? "ring-2 ring-sky-400"
            : "ring-2 ring-orange-400")
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-full text-white shadow-inner",
              player === "blue" ? "bg-sky-600" : "bg-orange-500"
            )}
          >
            {isAI ? (
              <Bot className="h-5 w-5" aria-hidden="true" />
            ) : (
              <User className="h-5 w-5" aria-hidden="true" />
            )}
          </div>
          <div>
            <div className="font-bold">{playerLabel(player)}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {isAI ? "AI" : "Human"}
              {reasoning ? ` | Reasoning ${reasoning}` : ""}
            </div>
          </div>
        </div>
        {active && (
          <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
            Turn
          </span>
        )}
      </div>
      {isAI && modelName && (
        <div className="mt-3 truncate text-xs text-slate-500 dark:text-slate-400">
          {modelName}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-slate-50 p-2 dark:bg-slate-900">
          <div className="text-slate-500 dark:text-slate-400">Fleet</div>
          <div className="mt-1 font-semibold">{remaining} cells</div>
        </div>
        <div className="rounded-lg bg-slate-50 p-2 dark:bg-slate-900">
          <div className="text-slate-500 dark:text-slate-400">Sunk</div>
          <div className="mt-1 font-semibold">{sunk}/5 ships</div>
        </div>
      </div>
      <GameAIPresence
        interaction={visibleInteraction}
        variant="card"
        className="mt-3"
      />
    </section>
  );
}
