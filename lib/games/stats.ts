import {
  exportStore,
  getGenericGameMatchRecords,
  replaceStore,
  saveGenericGameMatchRecord,
} from "../client/store";
import type {
  GameParticipant,
  GenericGameMatchRecord,
} from "./core/types";
import type { GameMatchRecord, GameModelStat } from "./chess/types";

const STORAGE_KEY = "aiboard-game-stats";

function getLocalStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined"
      ? null
      : globalThis.localStorage;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isGameMode(value: unknown): value is GameMatchRecord["mode"] {
  return value === "pvp" || value === "pvai" || value === "aivai";
}

function isGameResult(value: unknown): value is GameMatchRecord["result"] {
  return value === "white" || value === "black" || value === "draw";
}

function isLegacyMatchRecord(value: unknown): value is GameMatchRecord {
  if (!isObject(value)) return false;
  return (
    readString(value.id) !== undefined &&
    readString(value.timestamp) !== undefined &&
    isGameMode(value.mode) &&
    isGameResult(value.result) &&
    typeof value.moves === "number" &&
    typeof value.durationMs === "number" &&
    typeof value.whiteMoveMs === "number" &&
    typeof value.blackMoveMs === "number"
  );
}

function participant(
  id: "white" | "black",
  label: string,
  modelId: string | undefined,
  reasoningEffort: string | undefined
): GameParticipant {
  return {
    id,
    kind: modelId ? "ai" : "human",
    label,
    ...(modelId ? { modelId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function legacyMatchToGeneric(record: GameMatchRecord): GenericGameMatchRecord {
  return {
    id: record.id,
    gameId: "chess",
    timestamp: record.timestamp,
    participants: [
      participant("white", "White", record.whiteModel, record.whiteReasoningEffort),
      participant("black", "Black", record.blackModel, record.blackReasoningEffort),
    ],
    resultJson: JSON.stringify({ result: record.result }),
    statsJson: JSON.stringify({
      mode: record.mode,
      whiteModel: record.whiteModel,
      blackModel: record.blackModel,
      whiteReasoningEffort: record.whiteReasoningEffort,
      blackReasoningEffort: record.blackReasoningEffort,
      moves: record.moves,
      durationMs: record.durationMs,
      whiteMoveMs: record.whiteMoveMs,
      blackMoveMs: record.blackMoveMs,
    }),
  };
}

function inferMode(
  whiteModel: string | undefined,
  blackModel: string | undefined
): GameMatchRecord["mode"] {
  if (whiteModel && blackModel) return "aivai";
  if (whiteModel || blackModel) return "pvai";
  return "pvp";
}

function genericMatchToLegacy(record: GenericGameMatchRecord): GameMatchRecord | null {
  if (record.gameId !== "chess") return null;

  const result = parseObject(record.resultJson);
  const stats = parseObject(record.statsJson);
  const white = record.participants.find((p) => p.id === "white");
  const black = record.participants.find((p) => p.id === "black");
  const whiteModel = readString(stats.whiteModel) ?? white?.modelId;
  const blackModel = readString(stats.blackModel) ?? black?.modelId;
  const whiteReasoningEffort =
    readString(stats.whiteReasoningEffort) ?? white?.reasoningEffort;
  const blackReasoningEffort =
    readString(stats.blackReasoningEffort) ?? black?.reasoningEffort;
  const resultValue = result.result ?? result.winner;

  if (!isGameResult(resultValue)) return null;

  return {
    id: record.id,
    timestamp: record.timestamp,
    mode: isGameMode(stats.mode) ? stats.mode : inferMode(whiteModel, blackModel),
    ...(whiteModel ? { whiteModel } : {}),
    ...(blackModel ? { blackModel } : {}),
    ...(whiteReasoningEffort ? { whiteReasoningEffort } : {}),
    ...(blackReasoningEffort ? { blackReasoningEffort } : {}),
    result: resultValue,
    moves: readNumber(stats.moves),
    durationMs: readNumber(stats.durationMs),
    whiteMoveMs: readNumber(stats.whiteMoveMs),
    blackMoveMs: readNumber(stats.blackMoveMs),
  };
}

function getStoredGenericMatchRecords(): GenericGameMatchRecord[] | null {
  try {
    const records = getGenericGameMatchRecords();
    importLegacyMatchRecordsIfNeeded(records);
    return getGenericGameMatchRecords();
  } catch {
    return null;
  }
}

function importLegacyMatchRecordsIfNeeded(records: GenericGameMatchRecord[]): void {
  if (records.length > 0) return;

  const storage = getLocalStorage();
  if (!storage) return;

  try {
    const data = storage.getItem(STORAGE_KEY);
    if (!data) return;

    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return;

    for (const record of parsed) {
      if (isLegacyMatchRecord(record)) {
        saveGenericGameMatchRecord(legacyMatchToGeneric(record));
      }
    }
  } catch {
    // Silently skip malformed legacy data or unavailable storage.
  }
}

function replaceGenericMatchRecords(records: GenericGameMatchRecord[]): void {
  const currentStore = exportStore();
  replaceStore({ ...currentStore, gameMatchRecords: records });
}

function chessModelInvolvesRecord(
  record: GenericGameMatchRecord,
  modelId: string
): boolean {
  const chessRecord = genericMatchToLegacy(record);
  return (
    chessRecord?.whiteModel === modelId ||
    chessRecord?.blackModel === modelId
  );
}

/** Get all chess match records from the generic match-record store. */
export function getMatchRecords(): GameMatchRecord[] {
  return (getStoredGenericMatchRecords() ?? [])
    .map(genericMatchToLegacy)
    .filter((record): record is GameMatchRecord => record !== null);
}

/** Save a chess match record to the generic match-record store. */
export function saveMatchRecord(record: GameMatchRecord): void {
  try {
    getStoredGenericMatchRecords();
    saveGenericGameMatchRecord(legacyMatchToGeneric(record));
  } catch {
    // Silently fail if the client store is unavailable or locked.
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
  try {
    const records = getStoredGenericMatchRecords();
    if (!records) return;

    if (!modelId) {
      replaceGenericMatchRecords(records.filter((record) => record.gameId !== "chess"));
    } else {
      replaceGenericMatchRecords(
        records.filter(
          (record) =>
            record.gameId !== "chess" || !chessModelInvolvesRecord(record, modelId)
        )
      );
    }
  } catch {
    // Silently fail if the client store is unavailable or locked.
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
