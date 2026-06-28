"use client";

import type { ReactNode } from "react";
import { Circle, Sparkles, TriangleAlert } from "lucide-react";
import type { FireworksGameState } from "@/lib/games/fireworks/types";
import { FIREWORKS_COLORS, FIREWORKS_RANKS, scoreFireworksState } from "@/lib/games/fireworks/engine";
import { cn } from "@/lib/utils";

const COLOR_STYLES = {
  red: "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/35 dark:text-red-200",
  blue: "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/35 dark:text-sky-200",
  green: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-200",
};

export function FireworksBoard({ state }: { state: FireworksGameState }) {
  const currentPlayer = state.players[state.currentPlayerIndex];
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Fireworks
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Score {scoreFireworksState(state)} / 15
          </h1>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <Counter
            icon={<Sparkles className="h-4 w-4" aria-hidden="true" />}
            label="Clues"
            value={`${state.clueTokens} / ${state.maxClueTokens}`}
          />
          <Counter
            icon={<TriangleAlert className="h-4 w-4" aria-hidden="true" />}
            label="Mistakes"
            value={`${state.mistakeTokens} / ${state.maxMistakeTokens}`}
          />
          <Counter label="Deck" value={String(state.deck.length)} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {FIREWORKS_COLORS.map((color) => (
          <div key={color} className={cn("rounded-md border p-3", COLOR_STYLES[color])}>
            <div className="mb-3 flex items-center justify-between">
              <div className="font-semibold capitalize">{color}</div>
              <div className="text-sm font-medium">{state.stacks[color]} / 5</div>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {FIREWORKS_RANKS.map((rank) => {
                const built = state.stacks[color] >= rank;
                return (
                  <div
                    key={rank}
                    className={cn(
                      "flex aspect-square items-center justify-center rounded-md border text-sm font-semibold",
                      built
                        ? "border-current bg-white/70 shadow-sm dark:bg-white/10"
                        : "border-current/30 bg-transparent text-current/35"
                    )}
                  >
                    {built ? rank : "_"}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <span
          className={cn(
            "inline-flex items-center gap-2 rounded-full px-3 py-1 font-medium",
            state.status === "playing"
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200"
              : state.status === "completed"
                ? "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-200"
                : "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-200"
          )}
        >
          <Circle className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
          {state.status}
        </span>
        {currentPlayer && (
          <span className="text-slate-600 dark:text-slate-400">
            Turn {state.turn + 1}: {currentPlayer.label}
          </span>
        )}
      </div>
    </section>
  );
}

function Counter({
  icon,
  label,
  value,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 dark:border-slate-800">
      {icon}
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}
