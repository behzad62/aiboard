"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  TeamIqComboMatrixRow,
  TeamIqRecommendationCard,
} from "@/lib/benchmark/teamiq";

export function ParetoFrontier({
  rows,
  cards,
}: {
  rows: TeamIqComboMatrixRow[];
  cards: TeamIqRecommendationCard[];
}) {
  const frontier = rows.filter((row) => row.isParetoRecommended);
  const watch = rows.filter((row) =>
    ["watch", "dominated", "insufficient_data"].includes(
      row.recommendationLabel
    )
  );

  return (
    <div className="space-y-3">
      {cards.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {cards.map((card) => (
            <div
              key={`${card.kind}:${card.teamCompositionId}`}
              className="rounded-lg border bg-card px-4 py-3"
            >
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {card.title}
              </div>
              <div className="mt-1 truncate text-sm font-semibold">
                {card.teamName}
              </div>
              <div className="mt-1 text-sm tabular-nums">{card.value}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {card.detail}
              </div>
            </div>
          ))}
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Pareto frontier</CardTitle>
          <CardDescription>
            Frontier teams are not dominated across verified quality, cost,
            speed, and team lift. Watchlist rows need review before promotion.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-2">
          <FrontierGroup
            title="Recommended and tradeoff"
            rows={frontier}
            empty="No frontier teams yet."
          />
          <FrontierGroup
            title="Watchlist"
            rows={watch}
            empty="No watchlist or dominated teams yet."
          />
        </CardContent>
      </Card>
    </div>
  );
}

function FrontierGroup({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: TeamIqComboMatrixRow[];
  empty: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-sm font-medium">{title}</div>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {rows.slice(0, 5).map((row) => (
            <div key={row.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {row.teamName}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {row.modelIds.length} models - {row.attempts} attempt
                  {row.attempts === 1 ? "" : "s"}
                </div>
              </div>
              <div className="shrink-0 rounded-sm border px-2 py-1 text-xs">
                {row.recommendationLabel.replace(/_/g, " ")}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
