"use client";

import { MessageSquare, Sparkles } from "lucide-react";
import { resolveGameAIDisplay } from "@/lib/games/core/ai-interactions";
import type { GameAIInteraction } from "@/lib/games/core/types";
import { cn } from "@/lib/utils";

export interface GameAIPresenceProps {
  interaction: GameAIInteraction | null;
  className?: string;
  variant?: "panel" | "card";
}

export function GameAIPresence({
  interaction,
  className,
  variant = "panel",
}: GameAIPresenceProps) {
  const display = resolveGameAIDisplay(interaction);
  if (!display) return null;

  return (
    <div
      className={cn(
        "flex items-start gap-3 border shadow-sm",
        variant === "panel" &&
          "rounded-xl border-purple-200 bg-purple-50 px-4 py-3 text-purple-950 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-100",
        variant === "card" &&
          "rounded-lg border-current/10 bg-white/70 px-3 py-2 text-slate-800 dark:bg-slate-950/40 dark:text-slate-100",
        className
      )}
      data-testid="ai-presence"
      aria-live={interaction?.gesture === "thinking" ? "polite" : undefined}
    >
      <div
        className={cn(
          "mt-0.5 flex flex-shrink-0 items-center justify-center rounded-full",
          variant === "panel" &&
            "h-8 w-8 bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200",
          variant === "card" &&
            "h-7 w-7 bg-slate-950 text-white dark:bg-slate-100 dark:text-slate-950"
        )}
        aria-hidden="true"
      >
        {display.utterance ? (
          <MessageSquare className={variant === "card" ? "h-3.5 w-3.5" : "h-4 w-4"} />
        ) : (
          <Sparkles className={variant === "card" ? "h-3.5 w-3.5" : "h-4 w-4"} />
        )}
      </div>
      <div className="min-w-0">
        <div
          className={cn(
            "text-xs font-semibold uppercase tracking-wide",
            variant === "panel"
              ? "text-purple-700 dark:text-purple-300"
              : "text-slate-500 dark:text-slate-400"
          )}
        >
          {display.actorLabel} - {display.gestureLabel}
        </div>
        <p className="mt-1 text-sm leading-snug">{display.utterance}</p>
      </div>
    </div>
  );
}

export default GameAIPresence;
