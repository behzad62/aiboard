import type { GameMatchRecord } from "@/lib/games/chess/types";
import { createInitialState, makeMove, toFEN } from "@/lib/games/chess/engine";
import {
  getModelApiKey,
  getModelBaseURL,
  getModelRunnerToken,
  requestAIMove,
} from "@/lib/games/chess/ai";
import { saveMatchRecord } from "@/lib/games/stats";
import type { ChessBenchmarkProgress } from "./types";
import {
  BENCHMARK_MOVE_DELAY_MS,
  MAX_CHESS_BENCHMARK_MOVES,
  type ChessBenchmarkConfig,
} from "./types";
import { generateBenchmarkId, getModelDisplayName } from "./format";

export async function runSingleChessBenchmarkGame({
  config,
  gameNumber,
  isAborted,
  onProgress,
  totalGames,
}: {
  config: ChessBenchmarkConfig;
  gameNumber: number;
  isAborted: () => boolean;
  onProgress: (progress: ChessBenchmarkProgress) => void;
  totalGames: number;
}): Promise<GameMatchRecord | null> {
  const gameStartTime = Date.now();
  let state = createInitialState();
  let moveCount = 0;
  let whiteMoveMs = 0;
  let blackMoveMs = 0;
  const maxMoves = Math.max(
    1,
    Math.floor(config.maxMoves || MAX_CHESS_BENCHMARK_MOVES)
  );

  onProgress({
    currentGame: gameNumber,
    totalGames,
    moveCount: 0,
    currentTurn: "white",
    status: "Starting game...",
    fen: toFEN(state),
  });

  while (state.status === "playing" || state.status === "check") {
    if (isAborted()) return null;

    if (moveCount >= maxMoves) {
      state = { ...state, status: "draw" };
      break;
    }

    const isWhiteTurn = state.turn === "white";
    const currentModelId = isWhiteTurn
      ? config.whiteModelId
      : config.blackModelId;
    const currentReasoning = isWhiteTurn
      ? config.whiteReasoning
      : config.blackReasoning;

    onProgress({
      currentGame: gameNumber,
      totalGames,
      moveCount,
      currentTurn: state.turn,
      status: `${isWhiteTurn ? "White" : "Black"} (${getModelDisplayName(
        currentModelId
      )}) thinking...`,
      fen: toFEN(state),
    });

    const moveStartTime = Date.now();

    try {
      const apiKey = await getModelApiKey(currentModelId);
      const baseURL = getModelBaseURL(currentModelId);
      const runnerToken = getModelRunnerToken(currentModelId);

      if (!apiKey) {
        console.error(`No API key for model: ${currentModelId}`);
        state = { ...state, status: "draw" };
        break;
      }

      const result = await requestAIMove({
        state,
        modelId: currentModelId,
        reasoningEffort: currentReasoning,
        apiKey,
        baseURL,
        runnerToken,
      });

      const moveElapsed = Date.now() - moveStartTime;
      if (isWhiteTurn) whiteMoveMs += moveElapsed;
      else blackMoveMs += moveElapsed;

      if ("error" in result) {
        console.error(`AI move error: ${result.error}`);
        state = { ...state, status: "draw" };
        break;
      }

      const newState = makeMove(state, result.move);
      if (!newState) {
        console.error("Invalid move returned by AI:", result.move);
        state = { ...state, status: "draw" };
        break;
      }

      state = newState;
      moveCount++;
      await new Promise((resolve) =>
        setTimeout(resolve, BENCHMARK_MOVE_DELAY_MS)
      );
    } catch (err) {
      console.error("Error during AI move:", err);
      state = { ...state, status: "draw" };
      break;
    }
  }

  const result =
    state.status === "checkmate" && state.winner ? state.winner : "draw";
  const matchRecord: GameMatchRecord = {
    id: generateBenchmarkId(),
    timestamp: new Date().toISOString(),
    mode: "aivai",
    whiteModel: config.whiteModelId,
    blackModel: config.blackModelId,
    whiteReasoningEffort: config.whiteReasoning,
    blackReasoningEffort: config.blackReasoning,
    result,
    moves: moveCount,
    durationMs: Date.now() - gameStartTime,
    whiteMoveMs,
    blackMoveMs,
  };

  saveMatchRecord(matchRecord);
  return matchRecord;
}
