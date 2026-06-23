"use client";

import type { GameDescriptor, GameCatalogMode } from "@/lib/games/catalog";
import type { GameSessionRecord } from "@/lib/games/core/types";

const MODE_LABELS: Record<GameCatalogMode, string> = {
  pvp: "PvP",
  pvai: "PvAI",
  aivai: "AIvAI",
};

const ACCENT_CLASSES: Record<GameDescriptor["accent"], string> = {
  amber:
    "border-amber-200 bg-amber-50/70 hover:border-amber-400 dark:border-amber-900/70 dark:bg-amber-950/20 dark:hover:border-amber-600",
  "red-yellow":
    "border-red-200 bg-yellow-50/80 hover:border-red-400 dark:border-red-900/70 dark:bg-red-950/20 dark:hover:border-red-600",
};

const DOT_CLASSES: Record<GameDescriptor["accent"], string> = {
  amber: "bg-amber-500",
  "red-yellow": "bg-red-500",
};

export function GamePicker({
  games,
  resumableSessions,
  onSelectGame,
}: {
  games: GameDescriptor[];
  resumableSessions: GameSessionRecord[];
  onSelectGame: (gameId: string) => void;
}) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-50">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <header className="max-w-3xl">
          <p className="text-sm font-semibold uppercase text-slate-500 dark:text-slate-400">
            Games
          </p>
          <h1 className="mt-3 text-3xl font-bold text-slate-950 dark:text-white sm:text-4xl">
            Choose a board
          </h1>
          <p className="mt-3 text-base text-slate-600 dark:text-slate-300">
            Play locally, face an AI, or let models compete in a focused game
            arena.
          </p>
        </header>

        <section className="grid gap-4 md:grid-cols-2">
          {games.map((game) => {
            const hasResumableSession = resumableSessions.some(
              (session) => session.gameId === game.id
            );

            return (
              <button
                key={game.id}
                type="button"
                onClick={() => onSelectGame(game.id)}
                data-testid={`game-card-${game.id}`}
                className={`group flex min-h-56 flex-col justify-between rounded-lg border p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg ${ACCENT_CLASSES[game.accent]}`}
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="flex items-center gap-3">
                    <span
                      className={`h-3 w-3 rounded-full ${DOT_CLASSES[game.accent]}`}
                      aria-hidden="true"
                    />
                    <span className="text-2xl font-bold text-slate-950 dark:text-white">
                      {game.title}
                    </span>
                  </span>
                  {hasResumableSession && (
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200">
                      Resume
                    </span>
                  )}
                </span>

                <span className="mt-4 block text-sm leading-6 text-slate-700 dark:text-slate-300">
                  {game.summary}
                </span>

                <span className="mt-6 flex flex-wrap gap-2">
                  {game.modes.map((mode) => (
                    <span
                      key={mode}
                      className="rounded-full border border-slate-300 bg-white/80 px-3 py-1 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-200"
                    >
                      {MODE_LABELS[mode]}
                    </span>
                  ))}
                </span>
              </button>
            );
          })}
        </section>
      </main>
    </div>
  );
}
