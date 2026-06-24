"use client";

import type { GameMatchRecord, GameModelStat } from "@/lib/games/chess/types";
import { formatDate, formatDuration, getModelDisplayName } from "./format";

export function ChessBenchmarkStats({
  aggregateStats,
  modelStats,
  recentMatches,
  running,
}: {
  aggregateStats: {
    totalGames: number;
    avgMoves: number;
    avgDurationMs: number;
    whiteWins: number;
    blackWins: number;
    draws: number;
  } | null;
  modelStats: GameModelStat[];
  recentMatches: GameMatchRecord[];
  running: boolean;
}) {
  return (
    <>
      {aggregateStats && aggregateStats.totalGames > 0 && (
        <AggregateStats stats={aggregateStats} />
      )}
      {modelStats.length > 0 && <ModelStatsTable modelStats={modelStats} />}
      {recentMatches.length > 0 && (
        <RecentMatchesTable recentMatches={recentMatches} />
      )}
      {!running && modelStats.length === 0 && recentMatches.length === 0 && (
        <div className="rounded-lg border bg-card p-8 text-center">
          <div className="mb-2 text-lg font-medium">No AI vs AI Games Yet</div>
          <div className="text-sm text-muted-foreground">
            Configure the models above and click &quot;Run Benchmark&quot; to
            start an AI vs AI chess match.
          </div>
        </div>
      )}
    </>
  );
}

function AggregateStats({
  stats,
}: {
  stats: NonNullable<Parameters<typeof ChessBenchmarkStats>[0]["aggregateStats"]>;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-3 text-lg font-semibold">Aggregate Statistics</h3>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <StatCell label="Total Games" value={stats.totalGames} />
        <StatCell label="Avg Moves" value={Math.round(stats.avgMoves)} />
        <StatCell label="Avg Duration" value={formatDuration(stats.avgDurationMs)} />
        <StatCell
          label="White Wins"
          value={stats.whiteWins}
          className="text-amber-500"
        />
        <StatCell
          label="Black Wins"
          value={stats.blackWins}
          className="text-slate-700 dark:text-slate-300"
        />
        <StatCell
          label="Draws"
          value={stats.draws}
          className="text-muted-foreground"
        />
      </div>
    </div>
  );
}

function StatCell({
  className,
  label,
  value,
}: {
  className?: string;
  label: string;
  value: number | string;
}) {
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold ${className ?? ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function ModelStatsTable({ modelStats }: { modelStats: GameModelStat[] }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-3 text-lg font-semibold">Model Performance</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="px-2 py-2 text-left">Model</th>
              <th className="px-2 py-2 text-center">Games</th>
              <th className="px-2 py-2 text-center">Wins</th>
              <th className="px-2 py-2 text-center">Losses</th>
              <th className="px-2 py-2 text-center">Draws</th>
              <th className="px-2 py-2 text-center">Win Rate</th>
              <th className="px-2 py-2 text-center">Avg Move Time</th>
            </tr>
          </thead>
          <tbody>
            {modelStats.map((stat) => (
              <tr key={stat.modelId} className="border-b last:border-b-0">
                <td className="px-2 py-2 font-medium">
                  {getModelDisplayName(stat.modelId)}
                </td>
                <td className="px-2 py-2 text-center">{stat.games}</td>
                <td className="px-2 py-2 text-center text-green-600 dark:text-green-400">
                  {stat.wins}
                </td>
                <td className="px-2 py-2 text-center text-red-600 dark:text-red-400">
                  {stat.losses}
                </td>
                <td className="px-2 py-2 text-center text-muted-foreground">
                  {stat.draws}
                </td>
                <td className="px-2 py-2 text-center">
                  {stat.games > 0
                    ? `${Math.round((stat.wins / stat.games) * 100)}%`
                    : "-"}
                </td>
                <td className="px-2 py-2 text-center">
                  {formatDuration(stat.avgMoveMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecentMatchesTable({
  recentMatches,
}: {
  recentMatches: GameMatchRecord[];
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-3 text-lg font-semibold">Recent AI vs AI Matches</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="px-2 py-2 text-left">Date</th>
              <th className="px-2 py-2 text-left">White</th>
              <th className="px-2 py-2 text-left">Black</th>
              <th className="px-2 py-2 text-center">Result</th>
              <th className="px-2 py-2 text-center">Moves</th>
              <th className="px-2 py-2 text-center">Duration</th>
            </tr>
          </thead>
          <tbody>
            {recentMatches.map((match) => (
              <tr key={match.id} className="border-b last:border-b-0">
                <td className="px-2 py-2 text-muted-foreground">
                  {formatDate(match.timestamp)}
                </td>
                <td className="px-2 py-2">
                  {match.whiteModel ? getModelDisplayName(match.whiteModel) : "-"}
                </td>
                <td className="px-2 py-2">
                  {match.blackModel ? getModelDisplayName(match.blackModel) : "-"}
                </td>
                <td className="px-2 py-2 text-center">
                  <ResultBadge result={match.result} />
                </td>
                <td className="px-2 py-2 text-center">{match.moves}</td>
                <td className="px-2 py-2 text-center">
                  {formatDuration(match.durationMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResultBadge({ result }: { result: GameMatchRecord["result"] }) {
  const className =
    result === "white"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
      : result === "black"
        ? "bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200"
        : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${className}`}>
      {result === "white" ? "White" : result === "black" ? "Black" : "Draw"}
    </span>
  );
}
