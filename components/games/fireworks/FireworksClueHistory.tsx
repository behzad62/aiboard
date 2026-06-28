"use client";

import type { FireworksGameState } from "@/lib/games/fireworks/types";

export function FireworksClueHistory({ state }: { state: FireworksGameState }) {
  const events = [...state.events].reverse();
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="mb-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Turn history
        </div>
        <h2 className="mt-1 font-semibold">{events.length} actions</h2>
      </div>
      {events.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No actions yet.
        </p>
      ) : (
        <ol className="max-h-96 space-y-2 overflow-auto pr-1">
          {events.map((event) => (
            <li key={event.id} className="rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-800">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">Turn {event.turn + 1}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  score {event.resultingScore}
                </span>
              </div>
              <p className="mt-1 text-slate-700 dark:text-slate-300">{event.message}</p>
              {event.fallbackUsed && (
                <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                  Fallback action
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
