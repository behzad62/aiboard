"use client";

export function ConnectFourGameClient({
  onBackToGames,
}: {
  onBackToGames?: () => void;
}) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-red-50 via-yellow-50 to-slate-50 text-slate-950 dark:from-slate-950 dark:via-red-950/30 dark:to-slate-900 dark:text-white">
      <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col justify-center px-4 py-10 sm:px-6">
        <div className="space-y-6">
          {onBackToGames && (
            <button
              type="button"
              onClick={onBackToGames}
              className="rounded-md border border-slate-300 bg-white/80 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-white dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-200 dark:hover:bg-slate-900"
            >
              Back to games
            </button>
          )}
          <div>
            <p className="text-sm font-semibold uppercase text-red-600 dark:text-red-300">
              Connect Four
            </p>
            <h1 className="mt-3 text-4xl font-bold">Connect Four</h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-700 dark:text-slate-300">
              The Connect Four implementation starts in the next task. This
              page is wired into the games picker so navigation and session
              routing are ready.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
