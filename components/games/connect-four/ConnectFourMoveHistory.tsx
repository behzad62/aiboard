"use client";

import { useEffect, useRef } from "react";
import { ListOrdered } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectFourMoveRecord } from "@/lib/games/connect-four/types";

interface ConnectFourMoveHistoryProps {
  moveHistory: ConnectFourMoveRecord[];
  activeIndex?: number;
}

export function ConnectFourMoveHistory({
  moveHistory,
  activeIndex,
}: ConnectFourMoveHistoryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [moveHistory.length]);

  return (
    <section
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950"
      data-testid="connect-four-move-history"
    >
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/80">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
          <ListOrdered className="h-4 w-4" aria-hidden="true" />
          Moves
        </h3>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {moveHistory.length}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="max-h-64 min-h-[120px] overflow-y-auto px-2 py-2"
      >
        {moveHistory.length === 0 ? (
          <div className="flex h-[104px] items-center justify-center text-sm text-slate-400 dark:text-slate-500">
            No moves yet
          </div>
        ) : (
          <ol className="space-y-1">
            {moveHistory.map((record, index) => {
              const active = activeIndex === index;

              return (
                <li
                  key={`${record.timestamp}-${index}`}
                  className={cn(
                    "grid grid-cols-[2.5rem_1fr_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-sm",
                    active
                      ? "bg-amber-100 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100"
                      : "text-slate-700 dark:text-slate-300"
                  )}
                  data-replay-active={active || undefined}
                >
                  <span className="font-mono text-xs text-slate-400">
                    {index + 1}.
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        "h-3 w-3 shrink-0 rounded-full border",
                        record.player === "red"
                          ? "border-red-800 bg-red-500"
                          : "border-yellow-700 bg-yellow-400"
                      )}
                      aria-hidden="true"
                    />
                    <span className="truncate font-medium capitalize">
                      {record.player}
                    </span>
                  </span>
                  <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                    Col {record.displayColumn}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

export default ConnectFourMoveHistory;
