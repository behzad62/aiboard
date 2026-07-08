import type { ReasoningEffort } from "@/lib/db/schema";
import type { GenericGameMatchRecord, GameAIInteraction } from "@/lib/games/core/types";
import { isRecoverableGameAIError } from "@/lib/games/core/ai-errors";
import {
  createInitialCodenamesState,
  endCodenamesTurn,
  getCodenamesPublicBoard,
  submitCodenamesClue,
  submitCodenamesGuess,
  withCodenamesAIStrategyNote,
} from "./engine";
import {
  getCodenamesModelApiKey,
  getCodenamesModelBaseURL,
  getCodenamesModelRunnerToken,
  requestCodenamesGuesserMove,
  requestCodenamesSpymasterMove,
} from "./ai";
import type {
  CodenamesGameState,
  CodenamesMoveRecord,
  CodenamesTeam,
} from "./types";

export interface CodenamesMatchRecord {
  id: string;
  timestamp: string;
  mode: "aivai";
  redModel: string;
  blueModel: string;
  redReasoningEffort: ReasoningEffort;
  blueReasoningEffort: ReasoningEffort;
  result: CodenamesTeam | "draw";
  turns: number;
  moves: number;
  durationMs: number;
  avgAiResponseMs: number;
  invalidResponses: number;
  fallbackMoves: number;
  assassinHits: number;
}

export interface CodenamesBenchmarkProgress {
  moveCount: number;
  currentTurn: CodenamesTeam;
  status: string;
  result: CodenamesTeam | "draw" | null;
  invalidResponses: number;
  fallbackMoves: number;
  maxMoves: number;
}

export interface RunCodenamesBenchmarkParams {
  redModelId: string;
  blueModelId: string;
  redReasoning: ReasoningEffort;
  blueReasoning: ReasoningEffort;
  maxTurns: number;
  signal: AbortSignal;
  onProgress?: (progress: CodenamesBenchmarkProgress) => void;
}

interface CodenamesBenchmarkModelConfig {
  modelId: string;
  reasoning: ReasoningEffort;
  apiKey: string;
  baseURL?: string;
  runnerToken?: string;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function resultForState(state: CodenamesGameState): CodenamesTeam | "draw" {
  return state.status === "win" && state.winner ? state.winner : "draw";
}

function teamConfig(
  params: RunCodenamesBenchmarkParams,
  team: CodenamesTeam
): CodenamesBenchmarkModelConfig {
  const modelId = team === "red" ? params.redModelId : params.blueModelId;
  const reasoning = team === "red" ? params.redReasoning : params.blueReasoning;
  const apiKey = getCodenamesModelApiKey(modelId);
  if (!apiKey) throw new Error(`Missing API key for ${team} model: ${modelId}`);
  return {
    modelId,
    reasoning,
    apiKey,
    baseURL: getCodenamesModelBaseURL(modelId),
    runnerToken: getCodenamesModelRunnerToken(modelId),
  };
}

function isRecoverableCodenamesAIError(error: string): boolean {
  return isRecoverableGameAIError(error);
}

function emitProgress(
  params: RunCodenamesBenchmarkParams,
  state: CodenamesGameState,
  status: string,
  invalidResponses: number,
  fallbackMoves: number
): void {
  params.onProgress?.({
    moveCount: state.moveHistory.length,
    currentTurn: state.turnTeam,
    status,
    result: state.status === "playing" ? null : resultForState(state),
    invalidResponses,
    fallbackMoves,
    maxMoves: params.maxTurns,
  });
}

function attachInteractionToLatestMove(
  state: CodenamesGameState,
  interaction: GameAIInteraction | null
): CodenamesGameState {
  if (!interaction || state.moveHistory.length === 0) return state;
  return {
    ...state,
    moveHistory: state.moveHistory.map((move, index) =>
      index === state.moveHistory.length - 1
        ? ({ ...move, aiInteraction: interaction } as CodenamesMoveRecord)
        : move
    ),
  };
}

function fallbackGuess(state: CodenamesGameState): string | null {
  return getCodenamesPublicBoard(state).find((card) => !card.revealed)?.id ?? null;
}

export function codenamesMatchToGenericGameMatchRecord(
  record: CodenamesMatchRecord
): GenericGameMatchRecord {
  const winner = record.result === "draw" ? null : record.result;
  return {
    id: record.id,
    gameId: "codenames",
    timestamp: record.timestamp,
    participants: [
      {
        id: "red-spymaster",
        kind: "ai",
        label: "Red Spymaster",
        modelId: record.redModel,
        reasoningEffort: record.redReasoningEffort,
      },
      {
        id: "red-operative",
        kind: "ai",
        label: "Red Operative",
        modelId: record.redModel,
        reasoningEffort: record.redReasoningEffort,
      },
      {
        id: "blue-spymaster",
        kind: "ai",
        label: "Blue Spymaster",
        modelId: record.blueModel,
        reasoningEffort: record.blueReasoningEffort,
      },
      {
        id: "blue-operative",
        kind: "ai",
        label: "Blue Operative",
        modelId: record.blueModel,
        reasoningEffort: record.blueReasoningEffort,
      },
    ],
    resultJson: JSON.stringify({
      result: record.result,
      winner,
      draw: record.result === "draw",
    }),
    statsJson: JSON.stringify({
      turns: record.turns,
      moves: record.moves,
      durationMs: record.durationMs,
      avgAiResponseMs: record.avgAiResponseMs,
      invalidResponses: record.invalidResponses,
      fallbackMoves: record.fallbackMoves,
      assassinHits: record.assassinHits,
    }),
  };
}

export async function runCodenamesAIBenchmark(
  params: RunCodenamesBenchmarkParams
): Promise<CodenamesMatchRecord | null> {
  if (params.signal.aborted) return null;

  const startedAt = Date.now();
  const maxTurns = Math.max(1, Math.floor(params.maxTurns));
  const modelConfigs: Record<CodenamesTeam, CodenamesBenchmarkModelConfig> = {
    red: teamConfig(params, "red"),
    blue: teamConfig(params, "blue"),
  };
  let state = createInitialCodenamesState({
    seed: `benchmark-${startedAt}`,
    startingTeam: "red",
  });
  let turns = 0;
  let invalidResponses = 0;
  let fallbackMoves = 0;
  let totalAiResponseMs = 0;
  let aiResponseCount = 0;

  emitProgress(params, state, "Starting game...", invalidResponses, fallbackMoves);

  while (state.status === "playing" && turns < maxTurns) {
    if (params.signal.aborted) return null;
    const team = state.turnTeam;
    const config = modelConfigs[team];

    emitProgress(params, state, `${team === "red" ? "Red" : "Blue"} spymaster thinking...`, invalidResponses, fallbackMoves);
    const clueStartedAt = Date.now();
    const clueResult = await requestCodenamesSpymasterMove({
      state,
      team,
      modelId: config.modelId,
      reasoningEffort: config.reasoning,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      runnerToken: config.runnerToken,
      signal: params.signal,
    });
    totalAiResponseMs += Date.now() - clueStartedAt;
    aiResponseCount++;

    if (params.signal.aborted) return null;
    if ("error" in clueResult) {
      if (!isRecoverableCodenamesAIError(clueResult.error)) {
        throw new Error(clueResult.error);
      }
      invalidResponses++;
      state = submitCodenamesClue(state, { word: "fallback", count: 1 }, Date.now());
      fallbackMoves++;
    } else {
      state = submitCodenamesClue(state, clueResult.clue, Date.now());
      state = attachInteractionToLatestMove(state, clueResult.interaction);
      state = withCodenamesAIStrategyNote(
        state,
        team,
        "spymaster",
        clueResult.strategyNote
      );
    }
    turns++;

    emitProgress(params, state, `${team === "red" ? "Red" : "Blue"} operative thinking...`, invalidResponses, fallbackMoves);
    const guessStartedAt = Date.now();
    const guessResult = await requestCodenamesGuesserMove({
      state,
      team,
      modelId: config.modelId,
      reasoningEffort: config.reasoning,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      runnerToken: config.runnerToken,
      signal: params.signal,
    });
    totalAiResponseMs += Date.now() - guessStartedAt;
    aiResponseCount++;

    if (params.signal.aborted) return null;
    let guessed = false;
    if ("error" in guessResult) {
      if (!isRecoverableCodenamesAIError(guessResult.error)) {
        throw new Error(guessResult.error);
      }
      invalidResponses++;
    } else {
      for (const cardId of guessResult.cardIds) {
        if (state.status !== "playing" || state.phase !== "guess") break;
        try {
          state = submitCodenamesGuess(state, cardId, Date.now());
          state = attachInteractionToLatestMove(state, guessResult.interaction);
          state = withCodenamesAIStrategyNote(
            state,
            team,
            "operative",
            guessResult.strategyNote
          );
          guessed = true;
        } catch {
          invalidResponses++;
        }
      }
    }

    if (!guessed && state.status === "playing" && state.phase === "guess") {
      const fallbackCardId = fallbackGuess(state);
      if (!fallbackCardId) break;
      state = submitCodenamesGuess(state, fallbackCardId, Date.now());
      fallbackMoves++;
      guessed = true;
    }

    if (
      guessed &&
      state.status === "playing" &&
      state.phase === "guess" &&
      state.guessesMadeForActiveClue > 0
    ) {
      state = endCodenamesTurn(state, Date.now());
    }

    emitProgress(
      params,
      state,
      state.status === "win"
        ? `${state.winner === "red" ? "Red" : "Blue"} wins.`
        : "Turn applied.",
      invalidResponses,
      fallbackMoves
    );
  }

  const assassinHits = state.moveHistory.filter(
    (move) => move.type === "guess" && move.result === "assassin"
  ).length;

  return {
    id: generateId(),
    timestamp: new Date().toISOString(),
    mode: "aivai",
    redModel: params.redModelId,
    blueModel: params.blueModelId,
    redReasoningEffort: params.redReasoning,
    blueReasoningEffort: params.blueReasoning,
    result: resultForState(state),
    turns,
    moves: state.moveHistory.length,
    durationMs: Date.now() - startedAt,
    avgAiResponseMs:
      aiResponseCount > 0 ? Math.round(totalAiResponseMs / aiResponseCount) : 0,
    invalidResponses,
    fallbackMoves,
    assassinHits,
  };
}
