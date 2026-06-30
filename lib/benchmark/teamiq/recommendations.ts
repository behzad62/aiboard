import type {
  TeamIqComboMatrixRow,
  TeamIqRecommendationLabel,
} from "./combo-matrix";

export type TeamIqRecommendationCardKind =
  | "best_team_lift"
  | "best_quality"
  | "best_value"
  | "fastest"
  | "watchlist";

export interface TeamIqRecommendationCard {
  kind: TeamIqRecommendationCardKind;
  title: string;
  teamCompositionId: string;
  teamName: string;
  value: string;
  detail: string;
  recommendationLabel: TeamIqRecommendationLabel;
}

export function buildTeamIqRecommendationCards(
  rows: TeamIqComboMatrixRow[]
): TeamIqRecommendationCard[] {
  const teams = rows.filter((row) => !row.isSolo && row.attempts > 0);
  const cards = uniqueCards([
    cardFor("best_team_lift", "Best team lift", maxBy(teams, (row) => row.teamLift), (row) => ({
      value: signedScore(row.teamLift),
      detail: `Best solo ${score(row.bestSoloScore)} -> team ${score(row.jobSuccessScore)}`,
    })),
    cardFor("best_quality", "Best quality", maxBy(teams, (row) => row.verifiedQuality), (row) => ({
      value: score(row.verifiedQuality),
      detail: `${row.attempts} attempt${row.attempts === 1 ? "" : "s"} verified`,
    })),
    cardFor("best_value", "Best value", maxBy(teams, valueScore), (row) => ({
      value: `${score(row.verifiedQuality)} at ${money(row.averageCostUsd)}`,
      detail: "Highest verified quality per dollar",
    })),
    cardFor("fastest", "Fastest", minBy(teams, (row) => row.averageDurationMs), (row) => ({
      value: time(row.averageDurationMs),
      detail: `Verified quality ${score(row.verifiedQuality)}`,
    })),
    cardFor(
      "watchlist",
      "Watchlist",
      watchlistRow(teams),
      (row) => ({
        value: labelText(row.recommendationLabel),
        detail:
          row.teamLift == null
            ? "Missing complete solo baselines"
            : `Team lift ${signedScore(row.teamLift)}`,
      })
    ),
  ]);
  return cards;
}

function cardFor(
  kind: TeamIqRecommendationCardKind,
  title: string,
  row: TeamIqComboMatrixRow | null,
  values: (row: TeamIqComboMatrixRow) => { value: string; detail: string }
): TeamIqRecommendationCard | null {
  if (!row) return null;
  const rendered = values(row);
  return {
    kind,
    title,
    teamCompositionId: row.teamCompositionId,
    teamName: row.teamName,
    value: rendered.value,
    detail: rendered.detail,
    recommendationLabel: row.recommendationLabel,
  };
}

function uniqueCards(
  cards: Array<TeamIqRecommendationCard | null>
): TeamIqRecommendationCard[] {
  const used = new Set<string>();
  const result: TeamIqRecommendationCard[] = [];
  for (const card of cards) {
    if (!card) continue;
    const key = `${card.kind}:${card.teamCompositionId}`;
    if (used.has(key)) continue;
    used.add(key);
    result.push(card);
  }
  return result;
}

function watchlistRow(rows: TeamIqComboMatrixRow[]): TeamIqComboMatrixRow | null {
  return (
    rows.find((row) => row.recommendationLabel === "watch") ??
    rows.find((row) => row.recommendationLabel === "dominated") ??
    rows.find((row) => row.recommendationLabel === "insufficient_data") ??
    null
  );
}

function valueScore(row: TeamIqComboMatrixRow): number | null {
  if (row.averageCostUsd == null || row.averageCostUsd <= 0) return null;
  return row.verifiedQuality / row.averageCostUsd;
}

function maxBy(
  rows: TeamIqComboMatrixRow[],
  read: (row: TeamIqComboMatrixRow) => number | null
): TeamIqComboMatrixRow | null {
  return rows.reduce<TeamIqComboMatrixRow | null>((best, row) => {
    const value = read(row);
    if (value == null || !Number.isFinite(value)) return best;
    if (!best) return row;
    const bestValue = read(best);
    return bestValue == null || value > bestValue ? row : best;
  }, null);
}

function minBy(
  rows: TeamIqComboMatrixRow[],
  read: (row: TeamIqComboMatrixRow) => number | null
): TeamIqComboMatrixRow | null {
  return rows.reduce<TeamIqComboMatrixRow | null>((best, row) => {
    const value = read(row);
    if (value == null || !Number.isFinite(value)) return best;
    if (!best) return row;
    const bestValue = read(best);
    return bestValue == null || value < bestValue ? row : best;
  }, null);
}

function score(value: number | null): string {
  if (value == null) return "n/a";
  const normalized = value <= 1 ? value * 100 : value;
  return `${Math.round(normalized * 10) / 10}`;
}

function signedScore(value: number | null): string {
  if (value == null) return "n/a";
  return `${value > 0 ? "+" : ""}${score(value)}`;
}

function money(value: number | null): string {
  if (value == null) return "n/a";
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

function time(value: number | null): string {
  if (value == null) return "n/a";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${Math.round(value / 100) / 10}s`;
}

function labelText(label: TeamIqRecommendationLabel): string {
  return label.replace(/_/g, " ");
}
