"use client";

import type React from "react";
import { cn } from "@/lib/utils";
import type { GameStatus } from "@/lib/games/chess/types";

interface GameControlsProps {
  onReset: () => void;
  onPause: () => void;
  onResume: () => void;
  isPaused: boolean;
  gameStatus: GameStatus;
  canPause: boolean;
}

// Reset/Refresh icon
function ResetIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

// Pause icon
function PauseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

// Play/Resume icon
function PlayIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

// Status badge configuration
const STATUS_CONFIG: Record<
  GameStatus,
  { label: string; bgColor: string; textColor: string; icon?: React.ReactNode }
> = {
  playing: {
    label: "Playing",
    bgColor: "bg-green-100 dark:bg-green-900/30",
    textColor: "text-green-700 dark:text-green-400",
    icon: (
      <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
    ),
  },
  check: {
    label: "Check!",
    bgColor: "bg-orange-100 dark:bg-orange-900/30",
    textColor: "text-orange-700 dark:text-orange-400",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M12 2L1 21h22L12 2zm0 4l7.53 13H4.47L12 6zm-1 5v4h2v-4h-2zm0 6v2h2v-2h-2z" />
      </svg>
    ),
  },
  checkmate: {
    label: "Checkmate",
    bgColor: "bg-red-100 dark:bg-red-900/30",
    textColor: "text-red-700 dark:text-red-400",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
      </svg>
    ),
  },
  stalemate: {
    label: "Stalemate",
    bgColor: "bg-gray-100 dark:bg-gray-800",
    textColor: "text-gray-700 dark:text-gray-300",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z" />
        <path d="M11 7h2v6h-2zm0 8h2v2h-2z" />
      </svg>
    ),
  },
  draw: {
    label: "Draw",
    bgColor: "bg-blue-100 dark:bg-blue-900/30",
    textColor: "text-blue-700 dark:text-blue-400",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" />
      </svg>
    ),
  },
  paused: {
    label: "Paused",
    bgColor: "bg-yellow-100 dark:bg-yellow-900/30",
    textColor: "text-yellow-700 dark:text-yellow-400",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
      </svg>
    ),
  },
};

export function GameControls({
  onReset,
  onPause,
  onResume,
  isPaused,
  gameStatus,
  canPause,
}: GameControlsProps) {
  // Determine displayed status (override with paused if game is paused)
  const displayStatus = isPaused && gameStatus === "playing" ? "paused" : gameStatus;
  const statusConfig = STATUS_CONFIG[displayStatus];

  // Check if game is over
  const isGameOver = gameStatus === "checkmate" || gameStatus === "stalemate" || gameStatus === "draw";

  return (
    <div
      className={cn(
        "flex flex-col gap-4 p-4 rounded-xl",
        "border border-gray-200 dark:border-gray-700",
        "bg-white dark:bg-gray-900",
        "shadow-sm"
      )}
    >
      {/* Status badge */}
      <div className="flex items-center justify-center">
        <div
          className={cn(
            "inline-flex items-center gap-2 px-4 py-2 rounded-full",
            "text-sm font-semibold",
            "transition-all duration-300",
            statusConfig.bgColor,
            statusConfig.textColor
          )}
        >
          {statusConfig.icon}
          <span>{statusConfig.label}</span>
        </div>
      </div>

      {/* Control buttons */}
      <div className="flex items-center justify-center gap-3">
        {/* Reset button */}
        <button
          onClick={onReset}
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 rounded-lg",
            "font-medium text-sm",
            "transition-all duration-200",
            "bg-gray-100 dark:bg-gray-800",
            "text-gray-700 dark:text-gray-300",
            "hover:bg-gray-200 dark:hover:bg-gray-700",
            "active:scale-95",
            "border border-gray-200 dark:border-gray-600",
            "shadow-sm hover:shadow"
          )}
          title="Reset game"
        >
          <ResetIcon className="w-4 h-4" />
          <span>Reset</span>
        </button>

        {/* Pause/Resume button */}
        <button
          onClick={isPaused ? onResume : onPause}
          disabled={!canPause || isGameOver}
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 rounded-lg",
            "font-medium text-sm",
            "transition-all duration-200",
            "active:scale-95",
            "border shadow-sm",
            // Enabled states
            !isPaused && canPause && !isGameOver && [
              "bg-amber-100 dark:bg-amber-900/30",
              "text-amber-700 dark:text-amber-400",
              "border-amber-200 dark:border-amber-700",
              "hover:bg-amber-200 dark:hover:bg-amber-900/50",
              "hover:shadow",
            ],
            // Resume state
            isPaused && canPause && !isGameOver && [
              "bg-green-100 dark:bg-green-900/30",
              "text-green-700 dark:text-green-400",
              "border-green-200 dark:border-green-700",
              "hover:bg-green-200 dark:hover:bg-green-900/50",
              "hover:shadow",
            ],
            // Disabled state
            (!canPause || isGameOver) && [
              "bg-gray-50 dark:bg-gray-800/50",
              "text-gray-400 dark:text-gray-500",
              "border-gray-200 dark:border-gray-700",
              "cursor-not-allowed opacity-60",
            ]
          )}
          title={isPaused ? "Resume game" : "Pause game"}
        >
          {isPaused ? (
            <>
              <PlayIcon className="w-4 h-4" />
              <span>Resume</span>
            </>
          ) : (
            <>
              <PauseIcon className="w-4 h-4" />
              <span>Pause</span>
            </>
          )}
        </button>
      </div>

      {/* Game over message */}
      {isGameOver && (
        <div
          className={cn(
            "text-center text-sm text-gray-500 dark:text-gray-400",
            "pt-2 border-t border-gray-100 dark:border-gray-800"
          )}
        >
          Game over — click Reset to play again
        </div>
      )}
    </div>
  );
}

export default GameControls;