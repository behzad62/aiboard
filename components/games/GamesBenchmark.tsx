"use client";

import { useEffect, useState } from "react";
import {
  getAIvsAIAggregateStats,
  getAIvsAIModelStats,
  getRecentAIvsAIMatches,
} from "@/lib/games/stats";
import type { GameMatchRecord, GameModelStat } from "@/lib/games/chess/types";

/** Format milliseconds to human-readable duration */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/** Format date to relative or short date string */
function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return "Today";
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  }
}

/** Get display name from model ID */
function getModelDisplayName(modelId: string): string {
  // Extract the model name from provider:model format
  const parts = modelId.split(":");
  return parts.length > 1 ? parts[parts.length - 1] : modelId;
}

/** Stat card component */
function StatCard({
  label,
  value,
  subValue,
  icon,
}: {
  label: string;
  value: string | number;
  subValue?: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-gradient-to-br from-zinc-800/80 to-zinc-900/80 rounded-xl p-4 border border-zinc-700/50 shadow-lg hover:shadow-xl transition-shadow">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
            {label}
          </p>
          <p className="text-2xl font-bold text-white mt-1">{value}</p>
          {subValue && (
            <p className="text-xs text-zinc-500 mt-0.5">{subValue}</p>
          )}
        </div>
        <div className="text-zinc-500">{icon}</div>
      </div>
    </div>
  );
}

/** Result badge component */
function ResultBadge({ result }: { result: "white" | "black" | "draw" }) {
  const colors = {
    white: "bg-white/10 text-white border-white/20",
    black: "bg-zinc-600/50 text-zinc-200 border-zinc-500/30",
    draw: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  };

  const labels = {
    white: "White wins",
    black: "Black wins",
    draw: "Draw",
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${colors[result]}`}
    >
      {labels[result]}
    </span>
  );
}

/** Model stats table row */
function ModelStatRow({ stat, rank }: { stat: GameModelStat; rank: number }) {
  const winRate = stat.games > 0 ? ((stat.wins / stat.games) * 100).toFixed(1) : "0.0";
  
  return (
    <tr className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
      <td className="py-3 px-4">
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-zinc-700/50 text-xs font-medium text-zinc-400">
          {rank}
        </span>
      </td>
      <td className="py-3 px-4">
        <span className="font-medium text-zinc-200">{stat.displayName}</span>
      </td>
      <td className="py-3 px-4 text-center text-zinc-300">{stat.games}</td>
      <td className="py-3 px-4 text-center text-emerald-400">{stat.wins}</td>
      <td className="py-3 px-4 text-center text-red-400">{stat.losses}</td>
      <td className="py-3 px-4 text-center text-amber-400">{stat.draws}</td>
      <td className="py-3 px-4 text-center">
        <span className="font-semibold text-zinc-200">{winRate}%</span>
      </td>
      <td className="py-3 px-4 text-center text-zinc-400">
        {formatDuration(stat.avgMoveMs)}
      </td>
    </tr>
  );
}

/** Match history row */
function MatchRow({ match }: { match: GameMatchRecord }) {
  return (
    <tr className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
      <td className="py-3 px-4">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-white border border-zinc-600" />
          <span className="text-zinc-200 font-medium">
            {getModelDisplayName(match.whiteModel || "Unknown")}
          </span>
        </div>
      </td>
      <td className="py-3 px-4 text-center text-zinc-500">vs</td>
      <td className="py-3 px-4">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-zinc-700 border border-zinc-500" />
          <span className="text-zinc-200 font-medium">
            {getModelDisplayName(match.blackModel || "Unknown")}
          </span>
        </div>
      </td>
      <td className="py-3 px-4 text-center">
        <ResultBadge result={match.result} />
      </td>
      <td className="py-3 px-4 text-center text-zinc-400">{match.moves}</td>
      <td className="py-3 px-4 text-center text-zinc-400">
        {formatDuration(match.durationMs)}
      </td>
      <td className="py-3 px-4 text-right text-zinc-500 text-sm">
        {formatDate(match.timestamp)}
      </td>
    </tr>
  );
}

/** Empty state component */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="w-20 h-20 rounded-full bg-zinc-800/50 flex items-center justify-center mb-6">
        <svg
          className="w-10 h-10 text-zinc-600"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
          />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-zinc-300 mb-2">
        No AI vs AI Games Yet
      </h3>
      <p className="text-zinc-500 text-center max-w-md">
        Start an AI vs AI game to see benchmark statistics. Watch different AI
        models compete against each other and track their performance over time.
      </p>
    </div>
  );
}

/** Main GamesBenchmark component */
export function GamesBenchmark() {
  const [aggregateStats, setAggregateStats] = useState<ReturnType<
    typeof getAIvsAIAggregateStats
  > | null>(null);
  const [modelStats, setModelStats] = useState<GameModelStat[]>([]);
  const [recentMatches, setRecentMatches] = useState<GameMatchRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Load stats on mount
    const loadStats = () => {
      setAggregateStats(getAIvsAIAggregateStats());
      setModelStats(getAIvsAIModelStats());
      setRecentMatches(getRecentAIvsAIMatches(10));
      setIsLoading(false);
    };

    loadStats();

    // Listen for storage changes (in case games are played in another tab)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "aiboard-game-stats") {
        loadStats();
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-8 h-8 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
      </div>
    );
  }

  if (!aggregateStats || aggregateStats.totalGames === 0) {
    return <EmptyState />;
  }

  const whiteWinPct =
    aggregateStats.totalGames > 0
      ? ((aggregateStats.whiteWins / aggregateStats.totalGames) * 100).toFixed(1)
      : "0";
  const blackWinPct =
    aggregateStats.totalGames > 0
      ? ((aggregateStats.blackWins / aggregateStats.totalGames) * 100).toFixed(1)
      : "0";
  const drawPct =
    aggregateStats.totalGames > 0
      ? ((aggregateStats.draws / aggregateStats.totalGames) * 100).toFixed(1)
      : "0";

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <svg
            className="w-6 h-6 text-amber-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          AI vs AI Chess Benchmark
        </h2>
        <p className="text-zinc-400 text-sm mt-1">
          Performance statistics from AI model chess matches
        </p>
      </div>

      {/* Summary Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total Games"
          value={aggregateStats.totalGames}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          }
        />
        <StatCard
          label="Avg. Moves"
          value={aggregateStats.avgMoves}
          subValue="per game"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          }
        />
        <StatCard
          label="Avg. Duration"
          value={formatDuration(aggregateStats.avgDurationMs)}
          subValue="per game"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatCard
          label="Models Tested"
          value={modelStats.length}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          }
        />
      </div>

      {/* Win Distribution */}
      <div className="bg-gradient-to-br from-zinc-800/60 to-zinc-900/60 rounded-xl p-5 border border-zinc-700/50">
        <h3 className="text-sm font-semibold text-zinc-300 mb-4">
          Win Distribution
        </h3>
        <div className="flex items-center gap-4 mb-3">
          <div className="flex-1">
            <div className="h-3 bg-zinc-700/50 rounded-full overflow-hidden flex">
              <div
                className="h-full bg-gradient-to-r from-white to-zinc-200 transition-all"
                style={{ width: `${whiteWinPct}%` }}
              />
              <div
                className="h-full bg-gradient-to-r from-zinc-500 to-zinc-600 transition-all"
                style={{ width: `${blackWinPct}%` }}
              />
              <div
                className="h-full bg-gradient-to-r from-amber-500 to-amber-600 transition-all"
                style={{ width: `${drawPct}%` }}
              />
            </div>
          </div>
        </div>
        <div className="flex justify-between text-sm">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-white" />
            <span className="text-zinc-400">
              White: <span className="text-white font-medium">{aggregateStats.whiteWins}</span>{" "}
              <span className="text-zinc-500">({whiteWinPct}%)</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-zinc-600" />
            <span className="text-zinc-400">
              Black: <span className="text-white font-medium">{aggregateStats.blackWins}</span>{" "}
              <span className="text-zinc-500">({blackWinPct}%)</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-amber-500" />
            <span className="text-zinc-400">
              Draw: <span className="text-white font-medium">{aggregateStats.draws}</span>{" "}
              <span className="text-zinc-500">({drawPct}%)</span>
            </span>
          </div>
        </div>
      </div>

      {/* Model Leaderboard */}
      {modelStats.length > 0 && (
        <div className="bg-gradient-to-br from-zinc-800/60 to-zinc-900/60 rounded-xl border border-zinc-700/50 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-700/50">
            <h3 className="text-sm font-semibold text-zinc-300">
              Model Leaderboard
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Ranked by win rate in AI vs AI games
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-800/30">
                  <th className="py-2 px-4 text-left font-medium">#</th>
                  <th className="py-2 px-4 text-left font-medium">Model</th>
                  <th className="py-2 px-4 text-center font-medium">Games</th>
                  <th className="py-2 px-4 text-center font-medium">Wins</th>
                  <th className="py-2 px-4 text-center font-medium">Losses</th>
                  <th className="py-2 px-4 text-center font-medium">Draws</th>
                  <th className="py-2 px-4 text-center font-medium">Win Rate</th>
                  <th className="py-2 px-4 text-center font-medium">Avg Move</th>
                </tr>
              </thead>
              <tbody>
                {modelStats.map((stat, index) => (
                  <ModelStatRow key={stat.modelId} stat={stat} rank={index + 1} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Matches */}
      {recentMatches.length > 0 && (
        <div className="bg-gradient-to-br from-zinc-800/60 to-zinc-900/60 rounded-xl border border-zinc-700/50 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-700/50">
            <h3 className="text-sm font-semibold text-zinc-300">
              Recent Matches
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Last {recentMatches.length} AI vs AI games
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-800/30">
                  <th className="py-2 px-4 text-left font-medium">White</th>
                  <th className="py-2 px-4 text-center font-medium"></th>
                  <th className="py-2 px-4 text-left font-medium">Black</th>
                  <th className="py-2 px-4 text-center font-medium">Result</th>
                  <th className="py-2 px-4 text-center font-medium">Moves</th>
                  <th className="py-2 px-4 text-center font-medium">Duration</th>
                  <th className="py-2 px-4 text-right font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {recentMatches.map((match) => (
                  <MatchRow key={match.id} match={match} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default GamesBenchmark;