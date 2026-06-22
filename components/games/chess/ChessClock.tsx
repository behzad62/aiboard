"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { PieceColor } from "@/lib/games/chess/types";

interface ChessClockProps {
  color: PieceColor;
  timeMs: number;
  isActive: boolean;
  isPaused: boolean;
}

/**
 * Format milliseconds to time display string
 * Shows MM:SS for times under an hour, HH:MM:SS otherwise
 */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}

// Pause icon SVG
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

export function ChessClock({ color, timeMs, isActive, isPaused }: ChessClockProps) {
  const formattedTime = useMemo(() => formatTime(timeMs), [timeMs]);

  const isWhite = color === "white";

  return (
    <div
      data-testid={`chess-clock-${color}`}
      className={cn(
        "relative flex items-center gap-3 px-4 py-3 rounded-xl",
        "border-2 transition-all duration-300",
        "min-w-[160px]",
        // Base styling based on color
        isWhite
          ? "bg-gradient-to-br from-gray-50 to-gray-100 border-gray-200"
          : "bg-gradient-to-br from-gray-800 to-gray-900 border-gray-700",
        // Active state with glow effect
        isActive && !isPaused && [
          "ring-2 ring-offset-2",
          isWhite
            ? "ring-amber-400 ring-offset-white border-amber-400 shadow-[0_0_15px_rgba(251,191,36,0.4)]"
            : "ring-amber-500 ring-offset-gray-900 border-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.4)]",
        ],
        // Paused state
        isPaused && "opacity-75"
      )}
    >
      {/* Color indicator */}
      <div
        className={cn(
          "w-4 h-4 rounded-full border-2 flex-shrink-0",
          isWhite
            ? "bg-white border-gray-400 shadow-inner"
            : "bg-gray-900 border-gray-500"
        )}
      />

      {/* Player label and time */}
      <div className="flex flex-col">
        <span
          className={cn(
            "text-xs font-medium uppercase tracking-wide",
            isWhite ? "text-gray-500" : "text-gray-400"
          )}
        >
          {isWhite ? "White" : "Black"}
        </span>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "font-mono text-2xl font-bold tabular-nums tracking-tight",
              isWhite ? "text-gray-900" : "text-gray-100",
              isActive && !isPaused && "animate-pulse"
            )}
          >
            {formattedTime}
          </span>
          {/* Pause indicator */}
          {isPaused && (
            <span
              className={cn(
                "flex items-center gap-1 text-xs font-bold uppercase tracking-wider px-1.5 py-0.5 rounded",
                isWhite
                  ? "bg-yellow-100 text-yellow-700"
                  : "bg-yellow-900/40 text-yellow-400"
              )}
            >
              <PauseIcon className="w-3 h-3" />
              PAUSED
            </span>
          )}
        </div>
      </div>

      {/* Active indicator dot */}
      {isActive && !isPaused && (
        <div
          className={cn(
            "absolute -top-1 -right-1 w-3 h-3 rounded-full",
            "bg-green-500 animate-pulse",
            "ring-2 ring-white"
          )}
        />
      )}
    </div>
  );
}

export default ChessClock;