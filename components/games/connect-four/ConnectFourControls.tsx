"use client";

import {
  History,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectFourStatus } from "@/lib/games/connect-four/types";

interface ConnectFourControlsProps {
  status: ConnectFourStatus;
  isPaused: boolean;
  isReplayReviewing: boolean;
  canReplay: boolean;
  onReset: () => void;
  onPause: () => void;
  onResume: () => void;
  onReplayStart: () => void;
  onReplayPrevious: () => void;
  onReplayNext: () => void;
  onReplayExit: () => void;
  canReplayPrevious?: boolean;
  canReplayNext?: boolean;
}

const STATUS_LABELS: Record<ConnectFourStatus, string> = {
  playing: "Playing",
  paused: "Paused",
  win: "Win",
  draw: "Draw",
};

export function ConnectFourControls({
  status,
  isPaused,
  isReplayReviewing,
  canReplay,
  onReset,
  onPause,
  onResume,
  onReplayStart,
  onReplayPrevious,
  onReplayNext,
  onReplayExit,
  canReplayPrevious = canReplay,
  canReplayNext = canReplay,
}: ConnectFourControlsProps) {
  const displayStatus = isPaused && status === "playing" ? "paused" : status;
  const gameComplete = status === "win" || status === "draw";
  const pauseDisabled = gameComplete || isReplayReviewing;

  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950"
      data-testid="connect-four-controls"
    >
      <div className="mb-4 flex items-center justify-center">
        <span
          className={cn(
            "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold",
            displayStatus === "playing" &&
              "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
            displayStatus === "paused" &&
              "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
            displayStatus === "win" &&
              "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
            displayStatus === "draw" &&
              "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
          )}
        >
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              displayStatus === "playing" && "bg-emerald-500",
              displayStatus === "paused" && "bg-amber-500",
              displayStatus === "win" && "bg-red-500",
              displayStatus === "draw" && "bg-slate-500"
            )}
            aria-hidden="true"
          />
          {STATUS_LABELS[displayStatus]}
        </span>
      </div>

      <div className="flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={onReset}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700",
            "transition hover:bg-slate-100 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          )}
          data-testid="connect-four-reset"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Reset
        </button>

        <button
          type="button"
          onClick={isPaused ? onResume : onPause}
          disabled={pauseDisabled}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition active:scale-95",
            !pauseDisabled &&
              !isPaused &&
              "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-300",
            !pauseDisabled &&
              isPaused &&
              "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/35 dark:text-emerald-300",
            pauseDisabled &&
              "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 opacity-70 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-600"
          )}
          data-testid="connect-four-pause"
        >
          {isPaused ? (
            <Play className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Pause className="h-4 w-4" aria-hidden="true" />
          )}
          {isPaused ? "Resume" : "Pause"}
        </button>

        {!isReplayReviewing ? (
          <button
            type="button"
            onClick={onReplayStart}
            disabled={!canReplay}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition active:scale-95",
              canReplay
                ? "border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/35 dark:text-sky-300"
                : "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 opacity-70 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-600"
            )}
            data-testid="connect-four-replay-start"
          >
            <History className="h-4 w-4" aria-hidden="true" />
            Replay
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onReplayPrevious}
              disabled={!canReplayPrevious}
              className={replayButtonClass(canReplayPrevious)}
              data-testid="connect-four-replay-previous"
              aria-label="Previous replay move"
            >
              <SkipBack className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onReplayNext}
              disabled={!canReplayNext}
              className={replayButtonClass(canReplayNext)}
              data-testid="connect-four-replay-next"
              aria-label="Next replay move"
            >
              <SkipForward className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onReplayExit}
              className={replayButtonClass(true)}
              data-testid="connect-four-replay-exit"
              aria-label="Exit replay review"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function replayButtonClass(enabled: boolean): string {
  return cn(
    "inline-flex items-center justify-center rounded-lg border px-3 py-2 text-sm font-semibold transition active:scale-95",
    enabled
      ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
      : "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 opacity-70 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-600"
  );
}

export default ConnectFourControls;
