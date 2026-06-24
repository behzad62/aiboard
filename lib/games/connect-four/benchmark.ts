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
import {
  getCustomModelByFullId,
  getProvider,
} from "@/lib/client/providers";
import { parseModelId } from "@/lib/providers/base";
import type {
  ConnectFourGameState,
  ConnectFourMatchRecord,
  ConnectFourPlayer,
} from "@/lib/games/connect-four/types";
import type { GenericGameMatchRecord } from "@/lib/games/core/types";

interface ConnectFourBenchmarkModelConfig {
  modelId: string;
  reasoning: ReasoningEffort;
  apiKey: string;
  baseURL?: string;
}

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

export function connectFourMatchToGenericGameMatchRecord(
  record: ConnectFourMatchRecord
): GenericGameMatchRecord {
  const winner = record.result === "draw" ? null : record.result;

  return {
    id: record.id,
    gameId: "connect-four",
    timestamp: record.timestamp,
    participants: [
      {
        id: "red",
        kind: record.redModel ? "ai" : "human",
        label: "Red",
        ...(record.redModel ? { modelId: record.redModel } : {}),
        ...(record.redReasoningEffort
          ? { reasoningEffort: record.redReasoningEffort }
          : {}),
      },
      {
        id: "yellow",
        kind: record.yellowModel ? "ai" : "human",
        label: "Yellow",
        ...(record.yellowModel ? { modelId: record.yellowModel } : {}),
        ...(record.yellowReasoningEffort
          ? { reasoningEffort: record.yellowReasoningEffort }
          : {}),
      },
    ],
    resultJson: JSON.stringify({
      result: record.result,
      winner,
      draw: record.result === "draw",
    }),
    statsJson: JSON.stringify({
      moves: record.moves,
      durationMs: record.durationMs,
      avgAiResponseMs: record.avgAiResponseMs ?? null,
      invalidResponses: record.invalidResponses ?? null,
      fallbackMoves: record.fallbackMoves ?? null,
    }),
  };
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

function validatePlayerConfig(
  params: RunConnectFourBenchmarkParams,
  player: ConnectFourPlayer
): ConnectFourBenchmarkModelConfig {
  const { modelId, reasoning } = playerConfig(params, player);
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (!customModel && !getProvider(providerId)) {
    throw new Error(`Unknown provider for ${player} model: ${providerId}`);
  }

  const apiKey = getConnectFourModelApiKey(modelId);
  if (!apiKey) {
    throw new Error(
      `Missing API key for ${player === "red" ? "red" : "yellow"} model: ${modelId}`
    );
  }

  return {
    modelId,
    reasoning,
    apiKey,
    baseURL: getConnectFourModelBaseURL(modelId),
  };
}

export function isRecoverableConnectFourAIError(error: string): boolean {
  const normalized = error.toLowerCase();
  const nonrecoverableMarkers = [
    "missing api key",
    "unknown provider",
    "unauthorized",
    "forbidden",
    "invalid api key",
    "quota",
    "key limit",
    "401",
    "403",
    "aborted",
    "ai request failed",
  ];

  if (nonrecoverableMarkers.some((marker) => normalized.includes(marker))) {
    return false;
  }

  return (
    normalized.includes("parse") ||
    normalized.includes("illegal column") ||
    normalized.includes("valid column")
  );
}

function applyFallbackMove(state: ConnectFourGameState): ConnectFourGameState | null {
  const fallbackColumn = chooseFallbackConnectFourColumn(state);
  if (fallbackColumn === null) return null;
  return dropDisc(state, fallbackColumn, Date.now());
}

export async function runConnectFourAIBenchmark(
  params: RunConnectFourBenchmarkParams
): Promise<ConnectFourMatchRecord | null> {
  if (params.signal.aborted) {
    return null;
  }

  const startedAt = Date.now();
  const maxMoves = Math.max(1, Math.floor(params.maxMoves));
  const modelConfigs: Record<
    ConnectFourPlayer,
    ConnectFourBenchmarkModelConfig
  > = {
    red: validatePlayerConfig(params, "red"),
    yellow: validatePlayerConfig(params, "yellow"),
  };
  let state = createInitialConnectFourState();
  let invalidResponses = 0;
  let fallbackMoves = 0;
  let totalAiResponseMs = 0;
  let aiResponseCount = 0;

  emitProgress(params, state, "Starting game...", invalidResponses, fallbackMoves);

  while (state.status === "playing") {
    if (params.signal.aborted) {
      emitProgress(params, state, "Aborted.", invalidResponses, fallbackMoves);
      return null;
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
    const currentConfig = modelConfigs[currentPlayer];
    emitProgress(
      params,
      state,
      `${currentPlayer === "red" ? "Red" : "Yellow"} thinking...`,
      invalidResponses,
      fallbackMoves
    );

    const responseStartedAt = Date.now();
    let nextState: ConnectFourGameState | null = null;

    const aiResult = await requestConnectFourAIMove({
      state,
      modelId: currentConfig.modelId,
      reasoningEffort: currentConfig.reasoning,
      apiKey: currentConfig.apiKey,
      baseURL: currentConfig.baseURL,
      signal: params.signal,
    });
    totalAiResponseMs += Date.now() - responseStartedAt;
    aiResponseCount++;

    if (params.signal.aborted) {
      emitProgress(params, state, "Aborted.", invalidResponses, fallbackMoves);
      return null;
    }

    if ("error" in aiResult) {
      if (!isRecoverableConnectFourAIError(aiResult.error)) {
        throw new Error(aiResult.error);
      }
      invalidResponses++;
    } else {
      try {
        nextState = dropDisc(state, aiResult.column, Date.now());
      } catch {
        invalidResponses++;
      }
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
