import type { ReasoningEffort } from "@/lib/db/schema";
import type { GenericGameMatchRecord } from "@/lib/games/core/types";
import {
  attachBattleshipAIInteractionToLatestMove,
  createBattleshipBoard,
  createBattleshipStateWithBoards,
  createRandomBattleshipBoard,
  fireBattleshipShot,
} from "./engine";
import {
  chooseFallbackBattleshipTarget,
  getBattleshipModelApiKey,
  getBattleshipModelBaseURL,
  isRecoverableBattleshipAIError,
  requestBattleshipAIMove,
  requestBattleshipAIPlacement,
} from "./ai";
import type {
  BattleshipGameState,
  BattleshipPlayer,
  BattleshipPlayerBoard,
} from "./types";

export interface BattleshipMatchRecord {
  id: string;
  timestamp: string;
  mode: "aivai";
  blueModel: string;
  orangeModel: string;
  blueReasoningEffort: ReasoningEffort;
  orangeReasoningEffort: ReasoningEffort;
  result: BattleshipPlayer | "draw";
  shots: number;
  durationMs: number;
  avgAiResponseMs: number;
  invalidResponses: number;
  fallbackMoves: number;
  placementFallbacks: number;
}

export interface BattleshipBenchmarkProgress {
  moveCount: number;
  currentTurn: BattleshipPlayer;
  status: string;
  result: BattleshipPlayer | "draw" | null;
  invalidResponses: number;
  fallbackMoves: number;
  maxMoves: number;
}

export interface RunBattleshipBenchmarkParams {
  blueModelId: string;
  orangeModelId: string;
  blueReasoning: ReasoningEffort;
  orangeReasoning: ReasoningEffort;
  maxMoves: number;
  signal: AbortSignal;
  onProgress?: (progress: BattleshipBenchmarkProgress) => void;
}

interface BattleshipBenchmarkModelConfig {
  modelId: string;
  reasoning: ReasoningEffort;
  apiKey: string;
  baseURL?: string;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function resultForState(state: BattleshipGameState): BattleshipPlayer | "draw" {
  return state.status === "win" && state.winner ? state.winner : "draw";
}

function playerConfig(
  params: RunBattleshipBenchmarkParams,
  player: BattleshipPlayer
): BattleshipBenchmarkModelConfig {
  const modelId = player === "blue" ? params.blueModelId : params.orangeModelId;
  const reasoning =
    player === "blue" ? params.blueReasoning : params.orangeReasoning;
  const apiKey = getBattleshipModelApiKey(modelId);
  if (!apiKey) throw new Error(`Missing API key for ${player} model: ${modelId}`);
  return {
    modelId,
    reasoning,
    apiKey,
    baseURL: getBattleshipModelBaseURL(modelId),
  };
}

function emitProgress(
  params: RunBattleshipBenchmarkParams,
  state: BattleshipGameState,
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

async function resolveBoard({
  config,
  player,
  signal,
}: {
  config: BattleshipBenchmarkModelConfig;
  player: BattleshipPlayer;
  signal: AbortSignal;
}): Promise<{ board: BattleshipPlayerBoard; fallback: boolean }> {
  const placement = await requestBattleshipAIPlacement({
    player,
    modelId: config.modelId,
    reasoningEffort: config.reasoning,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    signal,
  });
  if ("ships" in placement) {
    return { board: createBattleshipBoard(placement.ships), fallback: false };
  }
  if (!isRecoverableBattleshipAIError(placement.error)) {
    throw new Error(placement.error);
  }
  return { board: createRandomBattleshipBoard(), fallback: true };
}

export function battleshipMatchToGenericGameMatchRecord(
  record: BattleshipMatchRecord
): GenericGameMatchRecord {
  const winner = record.result === "draw" ? null : record.result;
  return {
    id: record.id,
    gameId: "battleship",
    timestamp: record.timestamp,
    participants: [
      {
        id: "blue",
        kind: "ai",
        label: "Blue",
        modelId: record.blueModel,
        reasoningEffort: record.blueReasoningEffort,
      },
      {
        id: "orange",
        kind: "ai",
        label: "Orange",
        modelId: record.orangeModel,
        reasoningEffort: record.orangeReasoningEffort,
      },
    ],
    resultJson: JSON.stringify({
      result: record.result,
      winner,
      draw: record.result === "draw",
    }),
    statsJson: JSON.stringify({
      shots: record.shots,
      durationMs: record.durationMs,
      avgAiResponseMs: record.avgAiResponseMs,
      invalidResponses: record.invalidResponses,
      fallbackMoves: record.fallbackMoves,
      placementFallbacks: record.placementFallbacks,
    }),
  };
}

export async function runBattleshipAIBenchmark(
  params: RunBattleshipBenchmarkParams
): Promise<BattleshipMatchRecord | null> {
  if (params.signal.aborted) return null;

  const startedAt = Date.now();
  const maxMoves = Math.max(1, Math.floor(params.maxMoves));
  const modelConfigs: Record<BattleshipPlayer, BattleshipBenchmarkModelConfig> = {
    blue: playerConfig(params, "blue"),
    orange: playerConfig(params, "orange"),
  };
  let invalidResponses = 0;
  let fallbackMoves = 0;
  let placementFallbacks = 0;
  let totalAiResponseMs = 0;
  let aiResponseCount = 0;

  const blueBoard = await resolveBoard({
    config: modelConfigs.blue,
    player: "blue",
    signal: params.signal,
  });
  const orangeBoard = await resolveBoard({
    config: modelConfigs.orange,
    player: "orange",
    signal: params.signal,
  });
  placementFallbacks += blueBoard.fallback ? 1 : 0;
  placementFallbacks += orangeBoard.fallback ? 1 : 0;

  let state = createBattleshipStateWithBoards(blueBoard.board, orangeBoard.board);
  emitProgress(params, state, "Starting game...", invalidResponses, fallbackMoves);

  while (state.status === "playing") {
    if (params.signal.aborted) {
      emitProgress(params, state, "Aborted.", invalidResponses, fallbackMoves);
      return null;
    }
    if (state.moveHistory.length >= maxMoves) {
      emitProgress(params, state, "Reached the shot limit.", invalidResponses, fallbackMoves);
      break;
    }

    const player = state.turn;
    const config = modelConfigs[player];
    emitProgress(params, state, `${player === "blue" ? "Blue" : "Orange"} thinking...`, invalidResponses, fallbackMoves);

    const responseStartedAt = Date.now();
    const aiResult = await requestBattleshipAIMove({
      state,
      player,
      modelId: config.modelId,
      reasoningEffort: config.reasoning,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      signal: params.signal,
    });
    totalAiResponseMs += Date.now() - responseStartedAt;
    aiResponseCount++;

    if (params.signal.aborted) return null;

    let nextState: BattleshipGameState | null = null;
    if ("error" in aiResult) {
      if (!isRecoverableBattleshipAIError(aiResult.error)) {
        throw new Error(aiResult.error);
      }
      invalidResponses++;
    } else {
      try {
        nextState = fireBattleshipShot(state, aiResult.target, Date.now());
        nextState = attachBattleshipAIInteractionToLatestMove(
          nextState,
          aiResult.interaction ?? undefined
        );
      } catch {
        invalidResponses++;
      }
    }

    if (!nextState) {
      const fallbackTarget = chooseFallbackBattleshipTarget(state, player);
      if (!fallbackTarget) break;
      nextState = fireBattleshipShot(state, fallbackTarget, Date.now());
      fallbackMoves++;
    }

    state = nextState;
    emitProgress(
      params,
      state,
      state.status === "win"
        ? `${state.winner === "blue" ? "Blue" : "Orange"} wins.`
        : "Shot applied.",
      invalidResponses,
      fallbackMoves
    );
  }

  return {
    id: generateId(),
    timestamp: new Date().toISOString(),
    mode: "aivai",
    blueModel: params.blueModelId,
    orangeModel: params.orangeModelId,
    blueReasoningEffort: params.blueReasoning,
    orangeReasoningEffort: params.orangeReasoning,
    result: resultForState(state),
    shots: state.moveHistory.length,
    durationMs: Date.now() - startedAt,
    avgAiResponseMs:
      aiResponseCount > 0 ? Math.round(totalAiResponseMs / aiResponseCount) : 0,
    invalidResponses,
    fallbackMoves,
    placementFallbacks,
  };
}
