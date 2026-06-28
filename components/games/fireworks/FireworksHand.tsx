"use client";

import { Eye, EyeOff } from "lucide-react";
import type {
  FireworksPlayerView,
  FireworksVisibleCard,
  FireworksVisibleHand,
} from "@/lib/games/fireworks/types";
import { cn } from "@/lib/utils";

const COLOR_DOT = {
  red: "bg-red-500",
  blue: "bg-sky-500",
  green: "bg-emerald-500",
};

export function FireworksHand({
  view,
}: {
  view: FireworksPlayerView;
}) {
  return (
    <section className="grid gap-3 lg:grid-cols-[1fr_1fr]">
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Current hidden hand
            </div>
            <h2 className="mt-1 font-semibold">{view.playerLabel}</h2>
          </div>
          <EyeOff className="h-5 w-5 text-slate-500" aria-hidden="true" />
        </div>
        <div className="grid grid-cols-4 gap-2">
          {view.ownHand.cards.map((card, index) => (
            <CardTile
              key={`own-${index}`}
              card={card}
              index={index}
              hidden
            />
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {view.otherHands.map((hand) => (
          <VisibleHand key={hand.playerId} hand={hand} />
        ))}
      </div>
    </section>
  );
}

function VisibleHand({ hand }: { hand: FireworksVisibleHand }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Visible hand
          </div>
          <h2 className="mt-1 font-semibold">{hand.label}</h2>
        </div>
        <Eye className="h-5 w-5 text-slate-500" aria-hidden="true" />
      </div>
      <div className="grid grid-cols-4 gap-2">
        {hand.cards.map((card, index) => (
          <CardTile key={`${hand.playerId}-${index}`} card={card} index={index} />
        ))}
      </div>
    </div>
  );
}

function CardTile({
  card,
  index,
  hidden = false,
}: {
  card: FireworksVisibleCard;
  index: number;
  hidden?: boolean;
}) {
  const knownColor = card.color;
  const knownRank = card.rank;
  return (
    <div
      className={cn(
        "min-h-24 rounded-md border p-2 text-center",
        hidden
          ? "border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900"
          : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950"
      )}
    >
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
        Card {index}
      </div>
      <div className="mt-2 flex items-center justify-center gap-2">
        {knownColor ? (
          <span className={cn("h-3 w-3 rounded-full", COLOR_DOT[knownColor])} />
        ) : (
          <span className="h-3 w-3 rounded-full border border-slate-400" />
        )}
        <span className="font-semibold capitalize">{knownColor ?? "unknown"}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold">{knownRank ?? "?"}</div>
      {hidden && card.knowledge?.clueHistory.length ? (
        <div className="mt-2 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
          {card.knowledge.clueHistory.join("; ")}
        </div>
      ) : null}
    </div>
  );
}
