"use client";

import { MessageSquare, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { hasVisibleGameAIInteraction } from "@/lib/games/core/ai-interactions";
import type { GameAIInteraction } from "@/lib/games/core/types";

interface AIPresenceProps {
  interaction: GameAIInteraction | null;
}

const GESTURE_LABELS: Record<
  NonNullable<GameAIInteraction["gesture"]>,
  string
> = {
  thinking: "Thinking",
  confident: "Confident",
  confused: "Uncertain",
  celebrating: "Celebrating",
  apologetic: "Apologetic",
  neutral: "Neutral",
};

export function AIPresence({ interaction }: AIPresenceProps) {
  if (!hasVisibleGameAIInteraction(interaction)) return null;

  const label = interaction.gesture
    ? GESTURE_LABELS[interaction.gesture]
    : "AI note";
  const isQuietNote = !interaction.utterance;

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 shadow-sm",
        "border-purple-200 bg-purple-50 text-purple-950",
        "dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-100"
      )}
      data-testid="ai-presence"
    >
      <div
        className={cn(
          "mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
          "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200"
        )}
        aria-hidden="true"
      >
        {interaction.utterance ? (
          <MessageSquare className="h-4 w-4" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase tracking-wide text-purple-700 dark:text-purple-300">
          {interaction.actorId === "white" ? "White AI" : "Black AI"} - {label}
        </div>
        {!isQuietNote && (
          <p className="mt-1 text-sm leading-snug">{interaction.utterance}</p>
        )}
      </div>
    </div>
  );
}

export default AIPresence;
