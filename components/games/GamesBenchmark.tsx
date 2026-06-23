"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  getAIvsAIAggregateStats,
  getAIvsAIModelStats,
  getRecentAIvsAIMatches,
  saveMatchRecord,
} from "@/lib/games/stats";
import type { GameMatchRecord, GameModelStat } from "@/lib/games/chess/types";
import { createInitialState, toFEN, makeMove } from "@/lib/games/chess/engine";
import {
  requestAIMove,
  getAvailableModels,
  getModelApiKey,
  getModelBaseURL,
} from "@/lib/games/chess/ai";
import { ensureReady } from "@/lib/client/api";
import {
  registerGameBenchmark,
  type GameBenchmarkRunner,
} from "@/lib/games/core/benchmark";
import type { ReasoningEffort } from "@/lib/db/schema";

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_MOVES = 100;
const MOVE_DELAY_MS = 300;
const REASONING_LEVELS: { value: ReasoningEffort; label: string }[] = [
  { value: "default", label: "Disabled" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

interface AvailableModel {
  modelId: string;
  displayName: string;
}

interface BenchmarkConfig {
  whiteModelId: string;
  blackModelId: string;
  whiteReasoning: ReasoningEffort;
  blackReasoning: ReasoningEffort;
  numGames: number;
}

interface BenchmarkProgress {
  currentGame: number;
  totalGames: number;
  moveCount: number;
  currentTurn: "white" | "black";
  status: string;
  fen: string;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function getModelDisplayName(modelId: string): string {
  const parts = modelId.split(":");
  return parts.length > 1 ? parts[parts.length - 1] : modelId;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function GamesBenchmark() {
  // Available models
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [loading, setLoading] = useState(true);

  // Configuration
  const [config, setConfig] = useState<BenchmarkConfig>({
    whiteModelId: "",
    blackModelId: "",
    whiteReasoning: "default",
    blackReasoning: "default",
    numGames: 1,
  });

  // Benchmark state
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BenchmarkProgress | null>(null);
  const abortRef = useRef(false);

  // Stats display
  const [modelStats, setModelStats] = useState<GameModelStat[]>([]);
  const [recentMatches, setRecentMatches] = useState<GameMatchRecord[]>([]);
  const [aggregateStats, setAggregateStats] = useState<{
    totalGames: number;
    avgMoves: number;
    avgDurationMs: number;
    whiteWins: number;
    blackWins: number;
    draws: number;
  } | null>(null);

  // Load stats after the client store is ready and after benchmark completes.
  const loadStats = useCallback(() => {
    setModelStats(getAIvsAIModelStats());
    setRecentMatches(getRecentAIvsAIMatches(10));
    setAggregateStats(getAIvsAIAggregateStats());
  }, []);

  // Load available models on mount
  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      try {
        const { needsPassphrase } = await ensureReady();
        if (cancelled || needsPassphrase) return;

        const available = getAvailableModels();
        setModels(available);
        if (available.length >= 2) {
          setConfig((prev) => ({
            ...prev,
            whiteModelId: prev.whiteModelId || available[0].modelId,
            blackModelId: prev.blackModelId || available[Math.min(1, available.length - 1)].modelId,
          }));
        } else if (available.length === 1) {
          setConfig((prev) => ({
            ...prev,
            whiteModelId: prev.whiteModelId || available[0].modelId,
            blackModelId: prev.blackModelId || available[0].modelId,
          }));
        }
        loadStats();
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to load models:", err);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void loadModels();
    return () => {
      cancelled = true;
    };
  }, [loadStats]);

  // Run a single game
  const runSingleGame = useCallback(
    async (
      whiteModelId: string,
      blackModelId: string,
      whiteReasoning: ReasoningEffort,
      blackReasoning: ReasoningEffort,
      gameNumber: number,
      totalGames: number
    ): Promise<GameMatchRecord | null> => {
      const gameStartTime = Date.now();
      let state = createInitialState();
      let moveCount = 0;
      let whiteMoveMs = 0;
      let blackMoveMs = 0;

      setProgress({
        currentGame: gameNumber,
        totalGames,
        moveCount: 0,
        currentTurn: "white",
        status: "Starting game...",
        fen: toFEN(state),
      });

      while (
        state.status === "playing" ||
        state.status === "check"
      ) {
        if (abortRef.current) {
          return null;
        }

        if (moveCount >= MAX_MOVES) {
          // Draw by move limit
          state = { ...state, status: "draw" };
          break;
        }

        const isWhiteTurn = state.turn === "white";
        const currentModelId = isWhiteTurn ? whiteModelId : blackModelId;
        const currentReasoning = isWhiteTurn ? whiteReasoning : blackReasoning;

        setProgress({
          currentGame: gameNumber,
          totalGames,
          moveCount,
          currentTurn: state.turn,
          status: `${isWhiteTurn ? "White" : "Black"} (${getModelDisplayName(currentModelId)}) thinking...`,
          fen: toFEN(state),
        });

        const moveStartTime = Date.now();

        try {
          const apiKey = await getModelApiKey(currentModelId);
          const baseURL = getModelBaseURL(currentModelId);

          if (!apiKey) {
            console.error(`No API key for model: ${currentModelId}`);
            // End as draw due to configuration error
            state = { ...state, status: "draw" };
            break;
          }

          const result = await requestAIMove({
            state,
            modelId: currentModelId,
            reasoningEffort: currentReasoning,
            apiKey,
            baseURL,
          });

          const moveElapsed = Date.now() - moveStartTime;
          if (isWhiteTurn) {
            whiteMoveMs += moveElapsed;
          } else {
            blackMoveMs += moveElapsed;
          }

          if ("error" in result) {
            console.error(`AI move error: ${result.error}`);
            // End as draw due to AI error
            state = { ...state, status: "draw" };
            break;
          }

          // Apply the move
          const newState = makeMove(state, result.move);
          if (!newState) {
            console.error("Invalid move returned by AI:", result.move);
            state = { ...state, status: "draw" };
            break;
          }

          state = newState;
          moveCount++;

          // Delay between moves for visibility
          await new Promise((resolve) => setTimeout(resolve, MOVE_DELAY_MS));
        } catch (err) {
          console.error("Error during AI move:", err);
          state = { ...state, status: "draw" };
          break;
        }
      }

      // Determine result
      let result: "white" | "black" | "draw" = "draw";
      if (state.status === "checkmate" && state.winner) {
        result = state.winner;
      }

      const gameEndTime = Date.now();
      const durationMs = gameEndTime - gameStartTime;

      const matchRecord: GameMatchRecord = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        mode: "aivai",
        whiteModel: whiteModelId,
        blackModel: blackModelId,
        whiteReasoningEffort: whiteReasoning,
        blackReasoningEffort: blackReasoning,
        result,
        moves: moveCount,
        durationMs,
        whiteMoveMs,
        blackMoveMs,
      };

      saveMatchRecord(matchRecord);
      return matchRecord;
    },
    []
  );

  const runChessBenchmark = useCallback(
    async (
      benchmarkConfig: BenchmarkConfig,
      signal: AbortSignal
    ): Promise<GameMatchRecord[]> => {
      if (!benchmarkConfig.whiteModelId || !benchmarkConfig.blackModelId) {
        return [];
      }

      setRunning(true);
      abortRef.current = false;

      const results: GameMatchRecord[] = [];

      try {
        for (let i = 0; i < benchmarkConfig.numGames; i++) {
          if (signal.aborted || abortRef.current) {
            break;
          }

          const result = await runSingleGame(
            benchmarkConfig.whiteModelId,
            benchmarkConfig.blackModelId,
            benchmarkConfig.whiteReasoning,
            benchmarkConfig.blackReasoning,
            i + 1,
            benchmarkConfig.numGames
          );

          if (result) {
            results.push(result);
          }
        }
      } finally {
        setRunning(false);
        setProgress(null);
        loadStats();
      }

      return results;
    },
    [loadStats, runSingleGame]
  );

  useEffect(() => {
    const runner: GameBenchmarkRunner<BenchmarkConfig, GameMatchRecord[]> = {
      gameId: "chess",
      label: "AI vs AI Chess Benchmark",
      run: runChessBenchmark,
    };

    return registerGameBenchmark(runner);
  }, [runChessBenchmark]);

  // Run the full benchmark
  const runBenchmark = useCallback(async () => {
    const controller = new AbortController();
    await runChessBenchmark(config, controller.signal);
  }, [config, runChessBenchmark]);

  // Abort the benchmark
  const abortBenchmark = useCallback(() => {
    abortRef.current = true;
  }, []);

  // Handle configuration changes
  const updateConfig = useCallback(
    <K extends keyof BenchmarkConfig>(key: K, value: BenchmarkConfig[K]) => {
      setConfig((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-muted-foreground">Loading available models...</div>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="space-y-4 rounded-lg border bg-card p-6">
        <div>
          <h2 className="text-xl font-semibold">AI vs AI Chess Benchmark</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Run head-to-head chess matches between configured AI models and
            compare win rate, move speed, and reliability.
          </p>
        </div>
        <div className="text-center py-8">
          <div className="text-lg font-medium mb-2">No AI Models Available</div>
          <div className="text-muted-foreground text-sm">
            Configure API keys in Settings to enable AI models for benchmarking.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">AI vs AI Chess Benchmark</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Run head-to-head chess matches between configured AI models and
          compare win rate, move speed, and reliability.
        </p>
      </div>

      {/* Configuration Section */}
      <div className="bg-card border rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">Benchmark Configuration</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* White Model */}
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">White Model</label>
              <select
                value={config.whiteModelId}
                onChange={(e) => updateConfig("whiteModelId", e.target.value)}
                disabled={running}
                className="w-full px-3 py-2 border rounded-md bg-background text-foreground disabled:opacity-50"
              >
                {models.map((m) => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                White Reasoning: {REASONING_LEVELS.find((r) => r.value === config.whiteReasoning)?.label}
              </label>
              <input
                type="range"
                min={0}
                max={REASONING_LEVELS.length - 1}
                value={REASONING_LEVELS.findIndex((r) => r.value === config.whiteReasoning)}
                onChange={(e) =>
                  updateConfig("whiteReasoning", REASONING_LEVELS[parseInt(e.target.value)].value)
                }
                disabled={running}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                {REASONING_LEVELS.map((r) => (
                  <span key={r.value}>{r.label}</span>
                ))}
              </div>
            </div>
          </div>

          {/* Black Model */}
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">Black Model</label>
              <select
                value={config.blackModelId}
                onChange={(e) => updateConfig("blackModelId", e.target.value)}
                disabled={running}
                className="w-full px-3 py-2 border rounded-md bg-background text-foreground disabled:opacity-50"
              >
                {models.map((m) => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                Black Reasoning: {REASONING_LEVELS.find((r) => r.value === config.blackReasoning)?.label}
              </label>
              <input
                type="range"
                min={0}
                max={REASONING_LEVELS.length - 1}
                value={REASONING_LEVELS.findIndex((r) => r.value === config.blackReasoning)}
                onChange={(e) =>
                  updateConfig("blackReasoning", REASONING_LEVELS[parseInt(e.target.value)].value)
                }
                disabled={running}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                {REASONING_LEVELS.map((r) => (
                  <span key={r.value}>{r.label}</span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Number of Games */}
        <div className="mt-4">
          <label className="block text-sm font-medium mb-1">Number of Games (1-10)</label>
          <input
            type="number"
            min={1}
            max={10}
            value={config.numGames}
            onChange={(e) =>
              updateConfig("numGames", Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))
            }
            disabled={running}
            className="w-24 px-3 py-2 border rounded-md bg-background text-foreground disabled:opacity-50"
          />
        </div>

        {/* Action Buttons */}
        <div className="mt-4 flex gap-3">
          {!running ? (
            <button
              onClick={runBenchmark}
              disabled={!config.whiteModelId || !config.blackModelId}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Run Benchmark
            </button>
          ) : (
            <button
              onClick={abortBenchmark}
              className="px-4 py-2 bg-destructive text-destructive-foreground rounded-md hover:bg-destructive/90"
            >
              Stop Benchmark
            </button>
          )}
        </div>
      </div>

      {/* Progress Section */}
      {running && progress && (
        <div className="bg-card border rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-3">Benchmark Progress</h3>
          <div className="space-y-2">
            <div className="flex items-center gap-4">
              <span className="text-sm font-medium">
                Game {progress.currentGame} of {progress.totalGames}
              </span>
              <span className="text-sm text-muted-foreground">
                Move {progress.moveCount}
              </span>
              <span
                className={`text-sm font-medium ${
                  progress.currentTurn === "white" ? "text-amber-500" : "text-slate-700 dark:text-slate-300"
                }`}
              >
                {progress.currentTurn === "white" ? "⬜ White" : "⬛ Black"} to move
              </span>
            </div>
            <div className="text-sm text-muted-foreground">{progress.status}</div>
            <div className="mt-2">
              <code className="text-xs bg-muted px-2 py-1 rounded font-mono block overflow-x-auto">
                {progress.fen}
              </code>
            </div>
          </div>
        </div>
      )}

      {/* Aggregate Stats */}
      {aggregateStats && aggregateStats.totalGames > 0 && (
        <div className="bg-card border rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-3">Aggregate Statistics</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold">{aggregateStats.totalGames}</div>
              <div className="text-xs text-muted-foreground">Total Games</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold">{Math.round(aggregateStats.avgMoves)}</div>
              <div className="text-xs text-muted-foreground">Avg Moves</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold">{formatDuration(aggregateStats.avgDurationMs)}</div>
              <div className="text-xs text-muted-foreground">Avg Duration</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-amber-500">{aggregateStats.whiteWins}</div>
              <div className="text-xs text-muted-foreground">White Wins</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-slate-700 dark:text-slate-300">{aggregateStats.blackWins}</div>
              <div className="text-xs text-muted-foreground">Black Wins</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-muted-foreground">{aggregateStats.draws}</div>
              <div className="text-xs text-muted-foreground">Draws</div>
            </div>
          </div>
        </div>
      )}

      {/* Model Stats Table */}
      {modelStats.length > 0 && (
        <div className="bg-card border rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-3">Model Performance</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-2">Model</th>
                  <th className="text-center py-2 px-2">Games</th>
                  <th className="text-center py-2 px-2">Wins</th>
                  <th className="text-center py-2 px-2">Losses</th>
                  <th className="text-center py-2 px-2">Draws</th>
                  <th className="text-center py-2 px-2">Win Rate</th>
                  <th className="text-center py-2 px-2">Avg Move Time</th>
                </tr>
              </thead>
              <tbody>
                {modelStats.map((stat) => (
                  <tr key={stat.modelId} className="border-b last:border-b-0">
                    <td className="py-2 px-2 font-medium">{getModelDisplayName(stat.modelId)}</td>
                    <td className="text-center py-2 px-2">{stat.games}</td>
                    <td className="text-center py-2 px-2 text-green-600 dark:text-green-400">{stat.wins}</td>
                    <td className="text-center py-2 px-2 text-red-600 dark:text-red-400">{stat.losses}</td>
                    <td className="text-center py-2 px-2 text-muted-foreground">{stat.draws}</td>
                    <td className="text-center py-2 px-2">
                      {stat.games > 0 ? `${Math.round((stat.wins / stat.games) * 100)}%` : "-"}
                    </td>
                    <td className="text-center py-2 px-2">{formatDuration(stat.avgMoveMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Matches Table */}
      {recentMatches.length > 0 && (
        <div className="bg-card border rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-3">Recent AI vs AI Matches</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-2">Date</th>
                  <th className="text-left py-2 px-2">White</th>
                  <th className="text-left py-2 px-2">Black</th>
                  <th className="text-center py-2 px-2">Result</th>
                  <th className="text-center py-2 px-2">Moves</th>
                  <th className="text-center py-2 px-2">Duration</th>
                </tr>
              </thead>
              <tbody>
                {recentMatches.map((match) => (
                  <tr key={match.id} className="border-b last:border-b-0">
                    <td className="py-2 px-2 text-muted-foreground">{formatDate(match.timestamp)}</td>
                    <td className="py-2 px-2">{match.whiteModel ? getModelDisplayName(match.whiteModel) : "-"}</td>
                    <td className="py-2 px-2">{match.blackModel ? getModelDisplayName(match.blackModel) : "-"}</td>
                    <td className="text-center py-2 px-2">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${
                          match.result === "white"
                            ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                            : match.result === "black"
                            ? "bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200"
                            : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                        }`}
                      >
                        {match.result === "white" ? "White" : match.result === "black" ? "Black" : "Draw"}
                      </span>
                    </td>
                    <td className="text-center py-2 px-2">{match.moves}</td>
                    <td className="text-center py-2 px-2">{formatDuration(match.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!running && modelStats.length === 0 && recentMatches.length === 0 && (
        <div className="bg-card border rounded-lg p-8 text-center">
          <div className="text-lg font-medium mb-2">No AI vs AI Games Yet</div>
          <div className="text-sm text-muted-foreground">
            Configure the models above and click &quot;Run Benchmark&quot; to start an AI vs AI chess match.
          </div>
        </div>
      )}
    </div>
  );
}
