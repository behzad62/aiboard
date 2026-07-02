"use client";

import { Bot, UserRound } from "lucide-react";
import { GameAIPresence } from "@/components/games/GameAIPresence";
import { buildGameAIThinkingInteraction } from "@/lib/games/core/ai-interactions";
import type { GameAIInteraction } from "@/lib/games/core/types";
import type { CodenamesTeam } from "@/lib/games/codenames/types";
import { cn } from "@/lib/utils";
import { compactReasoningLabel, teamLabel } from "./view-helpers";

export function CodenamesTeamPanel({
  team,
  active,
  spymasterKind,
  operativeKind,
  remaining,
  spymasterModelLabel,
  operativeModelLabel,
  spymasterReasoning,
  operativeReasoning,
  spymasterInteraction,
  operativeInteraction,
  spymasterThinking,
  operativeThinking,
  winner,
}: {
  team: CodenamesTeam;
  active: boolean;
  spymasterKind: "human" | "ai";
  operativeKind: "human" | "ai";
  remaining: number;
  spymasterModelLabel?: string;
  operativeModelLabel?: string;
  spymasterReasoning?: string;
  operativeReasoning?: string;
  spymasterInteraction?: GameAIInteraction | null;
  operativeInteraction?: GameAIInteraction | null;
  spymasterThinking?: boolean;
  operativeThinking?: boolean;
  winner?: boolean;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border p-4 shadow-sm",
        team === "red"
          ? "border-red-200 bg-red-50/80 dark:border-red-900 dark:bg-red-950/25"
          : "border-blue-200 bg-blue-50/80 dark:border-blue-900 dark:bg-blue-950/25",
        active && "ring-2 ring-amber-400",
        winner && "ring-2 ring-emerald-400"
      )}
      data-testid={`codenames-team-${team}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {teamLabel(team)} team
          </div>
          <div className="mt-1 text-2xl font-black">{remaining}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            words left
          </div>
        </div>
        <span
          className={cn(
            "h-4 w-4 rounded-full",
            team === "red" ? "bg-red-500" : "bg-blue-500"
          )}
          aria-hidden="true"
        />
      </div>
      <RoleLine
        actorId={`${team}-spymaster`}
        label="Spymaster"
        kind={spymasterKind}
        modelLabel={spymasterModelLabel}
        reasoning={spymasterReasoning}
        interaction={spymasterInteraction}
        thinking={spymasterThinking}
      />
      <RoleLine
        actorId={`${team}-operative`}
        label="Operative"
        kind={operativeKind}
        modelLabel={operativeModelLabel}
        reasoning={operativeReasoning}
        interaction={operativeInteraction}
        thinking={operativeThinking}
      />
    </section>
  );
}

function RoleLine({
  actorId,
  label,
  kind,
  modelLabel,
  reasoning,
  interaction,
  thinking = false,
}: {
  actorId: string;
  label: string;
  kind: "human" | "ai";
  modelLabel?: string;
  reasoning?: string;
  interaction?: GameAIInteraction | null;
  thinking?: boolean;
}) {
  const visibleInteraction =
    kind === "ai"
      ? thinking
        ? buildGameAIThinkingInteraction(actorId)
        : interaction ?? null
      : null;

  return (
    <div className="mt-3 rounded-lg border border-white/70 bg-white/70 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950/40">
      <div className="flex items-center gap-2 font-semibold">
        {kind === "ai" ? (
          <Bot className="h-4 w-4 text-slate-500" aria-hidden="true" />
        ) : (
          <UserRound className="h-4 w-4 text-slate-500" aria-hidden="true" />
        )}
        {label}
      </div>
      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {kind === "ai"
          ? `${modelLabel ?? "AI"} - ${compactReasoningLabel(reasoning ?? "default")}`
          : "Human"}
      </div>
      <GameAIPresence
        interaction={visibleInteraction}
        variant="card"
        className="mt-3"
      />
    </div>
  );
}
