"use client";

import { useState } from "react";
import { Lightbulb, Send, StepForward } from "lucide-react";
import type {
  CodenamesClue,
  CodenamesPhase,
  CodenamesTeam,
} from "@/lib/games/codenames/types";
import { cn } from "@/lib/utils";
import { teamLabel } from "./view-helpers";

export function CodenamesCluePanel({
  phase,
  turnTeam,
  activeClue,
  guessesRemaining,
  guessesMade,
  canGiveClue,
  canEndTurn,
  onSubmitClue,
  onEndTurn,
}: {
  phase: CodenamesPhase;
  turnTeam: CodenamesTeam;
  activeClue: CodenamesClue | null;
  guessesRemaining: number;
  guessesMade: number;
  canGiveClue: boolean;
  canEndTurn: boolean;
  onSubmitClue: (clue: CodenamesClue) => void;
  onEndTurn: () => void;
}) {
  const [word, setWord] = useState("");
  const [count, setCount] = useState(1);

  const submit = () => {
    const trimmed = word.trim();
    if (!trimmed) return;
    onSubmitClue({ word: trimmed, count });
    setWord("");
    setCount(1);
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Current turn
          </div>
          <div className="mt-1 text-lg font-black">
            {teamLabel(turnTeam)} {phase === "clue" ? "spymaster" : "operatives"}
          </div>
        </div>
        <Lightbulb className="h-5 w-5 text-amber-500" aria-hidden="true" />
      </div>

      {phase === "clue" ? (
        <div className="mt-4 grid gap-3">
          <label className="grid gap-1 text-sm font-semibold">
            Clue
            <input
              value={word}
              disabled={!canGiveClue}
              onChange={(event) => setWord(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-950 shadow-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/30 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              placeholder="one word"
              data-testid="codenames-clue-word"
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Count
            <input
              type="number"
              min={0}
              max={9}
              value={count}
              disabled={!canGiveClue}
              onChange={(event) =>
                setCount(Math.max(0, Math.min(9, Number(event.target.value) || 0)))
              }
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-950 shadow-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/30 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              data-testid="codenames-clue-count"
            />
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={!canGiveClue || !word.trim()}
            className={cn(
              "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition active:scale-95",
              canGiveClue && word.trim()
                ? "bg-amber-500 text-slate-950 hover:bg-amber-400"
                : "cursor-not-allowed bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-500"
            )}
            data-testid="codenames-submit-clue"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            Submit clue
          </button>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-slate-950 dark:border-amber-900 dark:bg-amber-950/25 dark:text-amber-50">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            Active clue
          </div>
          <div className="mt-1 text-2xl font-black">
            {activeClue ? `${activeClue.word} ${activeClue.count}` : "No clue"}
          </div>
          <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {guessesRemaining} guess{guessesRemaining === 1 ? "" : "es"} left
          </div>
          <button
            type="button"
            onClick={onEndTurn}
            disabled={!canEndTurn || guessesMade < 1}
            className={cn(
              "mt-3 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition active:scale-95",
              canEndTurn && guessesMade >= 1
                ? "bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-white"
                : "cursor-not-allowed bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-500"
            )}
            data-testid="codenames-end-turn"
          >
            <StepForward className="h-4 w-4" aria-hidden="true" />
            End turn
          </button>
        </div>
      )}
    </section>
  );
}
