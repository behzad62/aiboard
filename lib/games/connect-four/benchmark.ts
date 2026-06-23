import type { ReasoningEffort } from "@/lib/db/schema";
import {
  chooseFallbackConnectFourColumn,
  getConnectFourModelApiKey,
  getConnectFourModelBaseURL,
  requestConnectFourAIMove,
} from "@/lib/games/connect-four/ai";
import {
  createInitialConnectFourState,
  dropDisc,
} from "@/lib/games/connect-four/engine";
import type {
  ConnectFourGameState,
  ConnectFourMatchRecord,
  ConnectFourPlayer,
} from "@/lib/games/connect-four/types";

export interface ConnectFourBenchmarkProgress {
  moveCount: number;
  currentTurn: ConnectFourPlayer;
  status: string;
  result: ConnectFourPlayer | "draw" | null;
  invalidResponses: number;
  fallbackMoves: number;
  maxMoves: number;
}

export interface RunConnectFourBenchmarkParams {
  redModelId: string;
  yellowModelId: string;
  redReasoning: ReasoningEffort;
  yellowReasoning: ReasoningEffort;
  maxMoves: number;
  signal: AbortSignal;
  onProgress?: (progress: ConnectFourBenchmarkProgress) => void;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function resultForState(state: ConnectFourGameState): ConnectFourPlayer | "draw" {
  return state.status === "win" && state.winner ? state.winner : "draw";
}

function emitProgress(
  params: RunConnectFourBenchmarkParams,
  state: ConnectFourGameState,
  status: string,
  invalidResponses: number,
  fallbackMoves: number
): void {
  params.onProgress?.({
    moveCount: state.moveHistory.length,
    currentTurn: state.turn,
    status,
    result: state.status === "playing" ? null : resultForState(state),
    invalidResponses,
    fallbackMoves,
    maxMoves: params.maxMoves,
  });
}

function playerConfig(
  params: RunConnectFourBenchmarkParams,
  player: ConnectFourPlayer
): { modelId: string; reasoning: ReasoningEffort } {
  return player === "red"
    ? { modelId: params.redModelId, reasoning: params.redReasoning }
    : { modelId: params.yellowModelId, reasoning: params.yellowReasoning };
}

function applyFallbackMove(state: ConnectFourGameState): ConnectFourGameState | null {
  const fallbackColumn = chooseFallbackConnectFourColumn(state);
  if (fallbackColumn === null) return null;
  return dropDisc(state, fallbackColumn, Date.now());
}

export async function runConnectFourAIBenchmark(
  params: RunConnectFourBenchmarkParams
): Promise<ConnectFourMatchRecord> {
  const startedAt = Date.now();
  const maxMoves = Math.max(1, Math.floor(params.maxMoves));
  let state = createInitialConnectFourState();
  let invalidResponses = 0;
  let fallbackMoves = 0;
  let totalAiResponseMs = 0;
  let aiResponseCount = 0;

  emitProgress(params, state, "Starting game...", invalidResponses, fallbackMoves);

  while (state.status === "playing") {
    if (params.signal.aborted) {
      emitProgress(params, state, "Aborted.", invalidResponses, fallbackMoves);
      break;
    }

    if (state.moveHistory.length >= maxMoves) {
      state = { ...state, status: "draw" };
      emitProgress(
        params,
        state,
        "Reached the move limit.",
        invalidResponses,
        fallbackMoves
      );
      break;
    }

    const currentPlayer = state.turn;
    const { modelId, reasoning } = playerConfig(params, currentPlayer);
    emitProgress(
      params,
      state,
      `${currentPlayer === "red" ? "Red" : "Yellow"} thinking...`,
      invalidResponses,
      fallbackMoves
    );

    const apiKey = getConnectFourModelApiKey(modelId);
    const responseStartedAt = Date.now();
    let nextState: ConnectFourGameState | null = null;

    if (apiKey) {
      const aiResult = await requestConnectFourAIMove({
        state,
        modelId,
        reasoningEffort: reasoning,
        apiKey,
        baseURL: getConnectFourModelBaseURL(modelId),
        signal: params.signal,
      });
      totalAiResponseMs += Date.now() - responseStartedAt;
      aiResponseCount++;

      if (params.signal.aborted) {
        emitProgress(params, state, "Aborted.", invalidResponses, fallbackMoves);
        break;
      }

      if ("error" in aiResult) {
        invalidResponses++;
      } else {
        try {
          nextState = dropDisc(state, aiResult.column, Date.now());
        } catch {
          invalidResponses++;
        }
      }
    } else {
      invalidResponses++;
    }

    if (!nextState) {
      try {
        nextState = applyFallbackMove(state);
        if (nextState) {
          fallbackMoves++;
        }
      } catch {
        nextState = null;
      }
    }

    if (!nextState) {
      state = { ...state, status: "draw" };
      emitProgress(
        params,
        state,
        "No legal fallback move was available.",
        invalidResponses,
        fallbackMoves
      );
      break;
    }

    state = nextState;
    emitProgress(
      params,
      state,
      state.status === "playing"
        ? "Move applied."
        : state.status === "win"
          ? `${state.winner === "red" ? "Red" : "Yellow"} wins.`
          : "Game drawn.",
      invalidResponses,
      fallbackMoves
    );
  }

  const durationMs = Date.now() - startedAt;
  return {
    id: generateId(),
    timestamp: new Date().toISOString(),
    mode: "aivai",
    redModel: params.redModelId,
    yellowModel: params.yellowModelId,
    redReasoningEffort: params.redReasoning,
    yellowReasoningEffort: params.yellowReasoning,
    result: resultForState(state),
    moves: state.moveHistory.length,
    durationMs,
    avgAiResponseMs:
      aiResponseCount > 0 ? Math.round(totalAiResponseMs / aiResponseCount) : 0,
    invalidResponses,
    fallbackMoves,
  };
}
