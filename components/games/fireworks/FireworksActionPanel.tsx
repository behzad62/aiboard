"use client";

import type { ReactNode } from "react";
import { Lightbulb, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FireworksAction, FireworksPlayerView } from "@/lib/games/fireworks/types";
import { cn } from "@/lib/utils";

export function FireworksActionPanel({
  view,
  disabled,
  onAction,
}: {
  view: FireworksPlayerView;
  disabled: boolean;
  onAction: (action: FireworksAction) => void;
}) {
  const plays = view.legalActions.filter((action) => action.action === "play");
  const discards = view.legalActions.filter((action) => action.action === "discard");
  const clues = view.legalActions.filter(
    (action) => action.action === "clue_color" || action.action === "clue_rank"
  );

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="mb-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Legal actions
        </div>
        <h2 className="mt-1 font-semibold">Choose one move</h2>
      </div>

      <div className="space-y-4">
        <ActionGroup title="Play">
          {plays.map((action) => (
            <Button
              key={`play-${action.cardIndex}`}
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => onAction(action)}
              className={cn(
                "justify-start",
                view.recommendations.knownPlayableCards.includes(action.cardIndex) &&
                  "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/35 dark:text-emerald-200"
              )}
            >
              <Play className="h-4 w-4" aria-hidden="true" />
              Card {action.cardIndex}
            </Button>
          ))}
        </ActionGroup>

        <ActionGroup title="Discard">
          {discards.map((action) => (
            <Button
              key={`discard-${action.cardIndex}`}
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => onAction(action)}
              className="justify-start"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Card {action.cardIndex}
            </Button>
          ))}
        </ActionGroup>

        <ActionGroup title="Clue">
          {clues.map((action) => (
            <Button
              key={clueKey(action)}
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => onAction(action)}
              className={cn(
                "justify-start",
                view.recommendations.visiblePlayableClues.some((candidate) => clueKey(candidate) === clueKey(action)) &&
                  "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/35 dark:text-sky-200"
              )}
            >
              <Lightbulb className="h-4 w-4" aria-hidden="true" />
              {formatClue(action)}
            </Button>
          ))}
          {clues.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No clue tokens or no identifying clues available.
            </p>
          )}
        </ActionGroup>
      </div>
    </section>
  );
}

function ActionGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium">{title}</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
        {children}
      </div>
    </div>
  );
}

function clueKey(action: FireworksAction): string {
  if (action.action === "clue_color") {
    return `${action.targetPlayerId}:color:${action.color}`;
  }
  if (action.action === "clue_rank") {
    return `${action.targetPlayerId}:rank:${action.rank}`;
  }
  return `${action.action}:${action.cardIndex}`;
}

function formatClue(action: FireworksAction): string {
  if (action.action === "clue_color") {
    return `${action.targetPlayerId} ${action.color}`;
  }
  if (action.action === "clue_rank") {
    return `${action.targetPlayerId} rank ${action.rank}`;
  }
  return action.action;
}
