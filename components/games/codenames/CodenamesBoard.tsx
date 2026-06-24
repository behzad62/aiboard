"use client";

import { Skull } from "lucide-react";
import type {
  CodenamesPhase,
  CodenamesPublicCard,
  CodenamesTeam,
} from "@/lib/games/codenames/types";
import { cn } from "@/lib/utils";
import { roleText } from "./view-helpers";

export function CodenamesBoard({
  cards,
  phase,
  turnTeam,
  canGuess,
  onGuess,
}: {
  cards: CodenamesPublicCard[];
  phase: CodenamesPhase;
  turnTeam: CodenamesTeam;
  canGuess: boolean;
  onGuess: (cardId: string) => void;
}) {
  return (
    <div
      className="grid aspect-square w-full max-w-[46rem] grid-cols-5 gap-2 rounded-2xl border border-slate-300 bg-slate-200 p-2 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
      data-testid="codenames-board"
    >
      {cards.map((card) => {
        const clickable = canGuess && phase === "guess" && !card.revealed;
        return (
          <button
            key={card.id}
            type="button"
            disabled={!clickable}
            onClick={() => onGuess(card.id)}
            className={cn(
              "relative flex min-h-0 flex-col justify-between overflow-hidden rounded-lg border p-2 text-left shadow-sm transition",
              "focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-2 focus:ring-offset-slate-100 dark:focus:ring-offset-slate-950",
              cardClass(card.role, card.revealed),
              clickable && "hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.99]",
              !clickable && "cursor-default"
            )}
            data-testid={`codenames-card-${card.position}`}
          >
            <span className="flex items-center justify-between gap-1">
              <span className="text-[0.65rem] font-bold uppercase tracking-wide opacity-70">
                {card.position}
              </span>
              <span className="text-[0.62rem] font-semibold uppercase opacity-70">
                {roleText(card.role)}
              </span>
            </span>
            <span className="flex min-h-0 flex-1 items-center justify-center px-1 text-center text-[clamp(0.72rem,1.9vw,1.25rem)] font-black uppercase tracking-wide">
              {card.word}
            </span>
            <span className="flex h-4 items-center justify-between text-[0.62rem] font-semibold uppercase opacity-75">
              <span>{card.revealed ? "Revealed" : "Live"}</span>
              {card.role === "assassin" && (
                <Skull className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </span>
            {!card.revealed && card.role === null && (
              <span
                className={cn(
                  "pointer-events-none absolute inset-x-3 bottom-1 h-1 rounded-full opacity-60",
                  turnTeam === "red" ? "bg-red-500" : "bg-blue-500"
                )}
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function cardClass(role: CodenamesPublicCard["role"], revealed: boolean): string {
  if (role === "red") {
    return revealed
      ? "border-red-600 bg-red-700 text-white"
      : "border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950/60 dark:text-red-50";
  }
  if (role === "blue") {
    return revealed
      ? "border-blue-600 bg-blue-700 text-white"
      : "border-blue-300 bg-blue-50 text-blue-950 dark:border-blue-800 dark:bg-blue-950/60 dark:text-blue-50";
  }
  if (role === "neutral") {
    return revealed
      ? "border-stone-500 bg-stone-600 text-white"
      : "border-stone-300 bg-stone-100 text-stone-950 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100";
  }
  if (role === "assassin") {
    return revealed
      ? "border-slate-950 bg-slate-950 text-white"
      : "border-slate-500 bg-slate-800 text-white";
  }
  return "border-amber-200 bg-amber-50 text-slate-950 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100";
}
