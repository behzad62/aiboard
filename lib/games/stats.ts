/**
 * Game statistics storage using localStorage
 */

import type { GameMatchRecord, GameModelStat } from "./chess/types";

const STORAGE_KEY = "aiboard-game-stats";

/** Check if we're in a browser environment */
function isBrowser(): boolean {
  return typeof window !== "undefined";
}

/** Get all match records from localStorage */
export function getMatchRecords(): GameMatchRecord[] {
  if (!isBrowser()) return [];

  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Save a match record to localStorage */
export function saveMatchRecord(record: GameMatchRecord): void {
  if (!isBrowser()) return;

  try {
    const records = getMatchRecords();
    records.push(record);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Silently fail if localStorage is unavailable
  }
}

/** Aggregate match records into per-model statistics */
export function getModelStats(): GameModelStat[] {
  const records = getMatchRecords();
  const statsMap = new Map<string, GameModelStat>();

  for (const record of records) {
    // Process white player (if AI)
    if (record.whiteModel) {
      updateModelStats(statsMap, record.whiteModel, record, "white");
    }

    // Process black player (if AI)
    if (record.blackModel) {
      updateModelStats(statsMap, record.blackModel, record, "black");
    }
  }

  // Calculate averages and convert to array
  const stats = Array.from(statsMap.values()).map((stat) => ({
    ...stat,
    avgMoveMs: stat.totalMoves > 0 ? stat.totalMoveMs / stat.totalMoves : 0,
  }));

  // Sort by win rate (wins / games), then by games played
  stats.sort((a, b) => {
    const winRateA = a.games > 0 ? a.wins / a.games : 0;
    const winRateB = b.games > 0 ? b.wins / b.games : 0;
    if (winRateB !== winRateA) return winRateB - winRateA;
    return b.games - a.games;
  });

  return stats;
}

/** Update stats for a specific model based on a match record */
function updateModelStats(
  statsMap: Map<string, GameModelStat>,
  modelId: string,
  record: GameMatchRecord,
  playedAs: "white" | "black"
): void {
  let stat = statsMap.get(modelId);

  if (!stat) {
    stat = {
      modelId,
      displayName: modelId.split(":").pop() || modelId,
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      totalMoves: 0,
      totalMoveMs: 0,
      avgMoveMs: 0,
      lastPlayed: record.timestamp,
    };
    statsMap.set(modelId, stat);
  }

  stat.games++;

  // Determine result for this model
  if (record.result === "draw") {
    stat.draws++;
  } else if (record.result === playedAs) {
    stat.wins++;
  } else {
    stat.losses++;
  }

  // Update move stats
  // Each player makes roughly half the moves
  const playerMoves = Math.ceil(record.moves / 2);
  stat.totalMoves += playerMoves;
  stat.totalMoveMs += playedAs === "white" ? record.whiteMoveMs : record.blackMoveMs;

  // Update last played timestamp
  if (record.timestamp > stat.lastPlayed) {
    stat.lastPlayed = record.timestamp;
  }
}

/** Reset game stats - optionally for a specific model only */
export function resetGameStats(modelId?: string): void {
  if (!isBrowser()) return;

  try {
    if (!modelId) {
      // Reset all stats
      localStorage.removeItem(STORAGE_KEY);
    } else {
      // Remove records involving the specific model
      const records = getMatchRecords();
      const filtered = records.filter(
        (r) => r.whiteModel !== modelId && r.blackModel !== modelId
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    }
  } catch {
    // Silently fail if localStorage is unavailable
  }
}

/** Get match records filtered by model ID */
export function getMatchRecordsForModel(modelId: string): GameMatchRecord[] {
  return getMatchRecords().filter(
    (r) => r.whiteModel === modelId || r.blackModel === modelId
  );
}

/** Get recent match records (last N matches) */
export function getRecentMatches(limit: number = 10): GameMatchRecord[] {
  const records = getMatchRecords();
  return records
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}

/** Get only AI vs AI match records */
export function getAIvsAIMatches(): GameMatchRecord[] {
  return getMatchRecords().filter((r) => r.mode === "aivai");
}

/** Get recent AI vs AI matches */
export function getRecentAIvsAIMatches(limit: number = 10): GameMatchRecord[] {
  const records = getAIvsAIMatches();
  return records
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}

/** Get model stats filtered for AI vs AI games only */
export function getAIvsAIModelStats(): GameModelStat[] {
  const records = getAIvsAIMatches();
  const statsMap = new Map<string, GameModelStat>();

  for (const record of records) {
    if (record.whiteModel) {
      updateModelStats(statsMap, record.whiteModel, record, "white");
    }
    if (record.blackModel) {
      updateModelStats(statsMap, record.blackModel, record, "black");
    }
  }

  const stats = Array.from(statsMap.values()).map((stat) => ({
    ...stat,
    avgMoveMs: stat.totalMoves > 0 ? stat.totalMoveMs / stat.totalMoves : 0,
  }));

  stats.sort((a, b) => {
    const winRateA = a.games > 0 ? a.wins / a.games : 0;
    const winRateB = b.games > 0 ? b.wins / b.games : 0;
    if (winRateB !== winRateA) return winRateB - winRateA;
    return b.games - a.games;
  });

  return stats;
}

/** Get aggregate AI vs AI statistics */
export function getAIvsAIAggregateStats(): {
  totalGames: number;
  avgMoves: number;
  avgDurationMs: number;
  whiteWins: number;
  blackWins: number;
  draws: number;
} {
  const records = getAIvsAIMatches();
  if (records.length === 0) {
    return { totalGames: 0, avgMoves: 0, avgDurationMs: 0, whiteWins: 0, blackWins: 0, draws: 0 };
  }

  let totalMoves = 0;
  let totalDuration = 0;
  let whiteWins = 0;
  let blackWins = 0;
  let draws = 0;

  for (const record of records) {
    totalMoves += record.moves;
    totalDuration += record.durationMs;
    if (record.result === "white") whiteWins++;
    else if (record.result === "black") blackWins++;
    else draws++;
  }

  return {
    totalGames: records.length,
    avgMoves: Math.round(totalMoves / records.length),
    avgDurationMs: Math.round(totalDuration / records.length),
    whiteWins,
    blackWins,
    draws,
  };
}

// Legacy aliases for compatibility with task spec
export const getGameMatches = getMatchRecords;
export const saveGameMatch = saveMatchRecord;
export const getGameModelStats = getModelStats;
