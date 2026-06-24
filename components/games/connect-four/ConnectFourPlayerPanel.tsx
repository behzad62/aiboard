"use client";

import { Bot, Clock, Trophy, User } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectFourPlayer } from "@/lib/games/connect-four/types";

interface ConnectFourPlayerPanelProps {
  player: ConnectFourPlayer;
  label: string;
  kind: "human" | "ai";
  modelLabel?: string;
  reasoningLabel?: string;
  elapsedMs: number;
  active: boolean;
  winner?: boolean;
}

const PLAYER_STYLES: Record<
  ConnectFourPlayer,
  { disc: string; panel: string; text: string }
> = {
  red: {
    disc: "border-red-800 bg-gradient-to-br from-red-300 via-red-500 to-red-800",
    panel:
      "border-red-200 bg-red-50/85 dark:border-red-900/70 dark:bg-red-950/25",
    text: "text-red-700 dark:text-red-300",
  },
  yellow: {
    disc: "border-yellow-700 bg-gradient-to-br from-yellow-100 via-amber-300 to-yellow-600",
    panel:
      "border-yellow-200 bg-yellow-50/85 dark:border-yellow-800/70 dark:bg-yellow-950/25",
    text: "text-yellow-700 dark:text-yellow-300",
  },
};

function formatElapsedTime(timeMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, timeMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function ConnectFourPlayerPanel({
  player,
  label,
  kind,
  modelLabel,
  reasoningLabel,
  elapsedMs,
  active,
  winner = false,
}: ConnectFourPlayerPanelProps) {
  const styles = PLAYER_STYLES[player];
  const KindIcon = kind === "ai" ? Bot : User;

  return (
    <section
      className={cn(
        "rounded-xl border p-4 shadow-sm transition duration-200",
        styles.panel,
        active && "ring-2 ring-amber-400 ring-offset-2 ring-offset-white dark:ring-offset-slate-950",
        winner && "shadow-[0_12px_28px_rgba(245,158,11,0.22)]"
      )}
      data-testid={`connect-four-player-${player}`}
      aria-current={active ? "true" : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn("h-8 w-8 shrink-0 rounded-full border-2", styles.disc)}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-slate-950 dark:text-white">
              {label}
            </h3>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
              <KindIcon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{kind === "ai" ? "AI" : "Human"}</span>
            </div>
          </div>
        </div>

        {winner ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
            aria-label={`${label} won`}
          >
            <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
            Winner
          </span>
        ) : active ? (
          <span
            className={cn("rounded-full px-2 py-1 text-xs font-semibold", styles.text)}
          >
            Turn
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-current/10 bg-white/60 px-3 py-2 dark:bg-slate-950/40">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          Time
        </span>
        <span
          className="font-mono text-lg font-bold tabular-nums text-slate-950 dark:text-white"
          data-testid={`connect-four-clock-${player}`}
        >
          {formatElapsedTime(elapsedMs)}
        </span>
      </div>

      {kind === "ai" && (
        <div className="mt-3 space-y-1 border-t border-current/10 pt-3 text-xs text-slate-600 dark:text-slate-400">
          {modelLabel && (
            <p className="truncate">
              <span className="font-medium text-slate-700 dark:text-slate-300">
                Model:
              </span>{" "}
              {modelLabel}
            </p>
          )}
          {reasoningLabel && (
            <p>
              <span className="font-medium text-slate-700 dark:text-slate-300">
                Reasoning:
              </span>{" "}
              {reasoningLabel}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export default ConnectFourPlayerPanel;
