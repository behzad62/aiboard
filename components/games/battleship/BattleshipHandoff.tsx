"use client";

import { EyeOff } from "lucide-react";
import type { BattleshipPlayer } from "@/lib/games/battleship/types";
import { playerLabel } from "./view-helpers";

export function BattleshipHandoff({
  nextPlayer,
  seconds,
  onSkip,
}: {
  nextPlayer: BattleshipPlayer;
  seconds: number;
  onSkip: () => void;
}) {
  return (
    <section className="flex min-h-[32rem] items-center justify-center rounded-2xl border border-slate-200 bg-slate-950 p-6 text-white shadow-xl dark:border-slate-800">
      <div className="max-w-md text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-slate-800 text-sky-200">
          <EyeOff className="h-8 w-8" aria-hidden="true" />
        </div>
        <p className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Private handoff
        </p>
        <h2 className="mt-2 text-3xl font-bold">
          {playerLabel(nextPlayer)} prepares
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          Pass the screen now. The next board appears after the countdown.
        </p>
        <div className="mx-auto mt-6 flex h-24 w-24 items-center justify-center rounded-full border border-sky-400 bg-sky-950 text-4xl font-bold text-sky-100">
          {seconds}
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="mt-6 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-100 transition hover:bg-slate-800 active:scale-95"
          data-testid="battleship-handoff-skip"
        >
          Show board
        </button>
      </div>
    </section>
  );
}
