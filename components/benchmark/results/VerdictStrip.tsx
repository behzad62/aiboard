"use client";

// The Results tab's four-card verdict strip, answering the product's core
// questions at a glance: which model is smartest, which team is best, and
// which is most efficient solo and as a team. Subsumes the old
// BestModelVerdictCard (single "best model overall" card) and
// CertifiedRecommendationCards (five-card quality/efficiency/speed/tool/
// team-lift strip) from CertifiedBenchmarkOverview.tsx — both deleted in the
// 2026-07-17 benchmark UX overhaul (Task 5). Every number here is computed by
// the SAME selectors those components used
// (lib/benchmark/certified/dashboard-selectors.ts); this component only picks
// which four cards to show and how to word the evidence line.
import { useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatNormalizedScore, usd } from "@/components/benchmark/format";
import {
  isTeamRow,
  pickBestTeamLiftCard,
  pickCheapestByTokens,
  pickMostEfficient,
  readLeaderboard,
  readModelIntelligence,
  readTeamIqRecommendationCards,
  type CertifiedLeaderboardRow,
} from "@/lib/benchmark/certified/dashboard-selectors";

interface VerdictCard {
  label: string;
  winner: string | null;
  evidence: string;
  emptyHint: string;
}

export function VerdictStrip({ certified }: { certified: unknown }) {
  const modelIntelligence = useMemo(
    () => readModelIntelligence(certified),
    [certified]
  );
  const leaderboard = useMemo(
    () => readLeaderboard(certified, "all", "quality"),
    [certified]
  );
  const teamIqCards = useMemo(
    () => readTeamIqRecommendationCards(certified),
    [certified]
  );
  const teamRows = useMemo(
    () => leaderboard.filter(isTeamRow),
    [leaderboard]
  );

  const smartest = modelIntelligence[0] ?? null;
  const bestTeamCard = pickBestTeamLiftCard(teamIqCards);
  const mostEfficient = pickMostEfficient(leaderboard);
  const cheapestByTokens = mostEfficient ? null : pickCheapestByTokens(leaderboard);
  const bestValueTeam = pickMostEfficient(teamRows);
  const cheapestTeamByTokens = bestValueTeam
    ? null
    : pickCheapestByTokens(teamRows);

  const cards: VerdictCard[] = [
    {
      label: "Smartest model",
      winner: smartest?.displayName ?? null,
      evidence: smartest
        ? `Verified quality ${formatNormalizedScore(smartest.combinedScore)} across ${
            smartest.trackCount
          } track${smartest.trackCount === 1 ? "" : "s"}${
            smartest.preliminary ? " (thin evidence)" : ""
          }.`
        : "",
      emptyHint:
        "Run solo certified attempts across the tracks to rank models by cross-track intelligence.",
    },
    {
      label: "Best team",
      winner: bestTeamCard?.teamName ?? null,
      evidence: bestTeamCard
        ? `${bestTeamCard.value}${
            bestTeamCard.detail ? ` - ${bestTeamCard.detail}` : ""
          }`
        : "",
      emptyHint: "Run the TeamIQ pack with solo baselines to compare teams.",
    },
    {
      label: "Most efficient",
      winner: efficiencyWinnerName(mostEfficient, cheapestByTokens),
      evidence: efficiencyEvidence(mostEfficient, cheapestByTokens),
      emptyHint:
        "Run certified attempts with pricing or token usage to rank efficiency.",
    },
    {
      label: "Best value team",
      winner: efficiencyWinnerName(bestValueTeam, cheapestTeamByTokens),
      evidence: efficiencyEvidence(bestValueTeam, cheapestTeamByTokens, "team "),
      emptyHint:
        "Run a team with solo baselines and pricing or token usage to rank team value.",
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardHeader className="gap-1 pb-2">
            <CardDescription className="text-xs font-medium uppercase tracking-wide">
              {card.label}
            </CardDescription>
            <CardTitle className="truncate text-lg">
              {card.winner ?? "No runs yet"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {card.winner ? card.evidence : card.emptyHint}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function efficiencyWinnerName(
  priced: CertifiedLeaderboardRow | null,
  tokenFallback: CertifiedLeaderboardRow | null
): string | null {
  return priced?.label ?? tokenFallback?.label ?? null;
}

function efficiencyEvidence(
  priced: CertifiedLeaderboardRow | null,
  tokenFallback: CertifiedLeaderboardRow | null,
  qualityNoun = ""
): string {
  if (priced) {
    return `${formatNormalizedScore(priced.verifiedQuality)} ${qualityNoun}quality at ${usd(
      priced.averageCostUsd
    )}.`;
  }
  if (tokenFallback?.tokensPerPass != null) {
    return `${tokenFallback.tokensPerPass.toLocaleString()} tokens/pass — no pricing available.`;
  }
  return "";
}
