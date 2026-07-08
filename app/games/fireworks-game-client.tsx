"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bot, RefreshCw, RotateCcw, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GameAIPresence } from "@/components/games/GameAIPresence";
import { FireworksActionPanel } from "@/components/games/fireworks/FireworksActionPanel";
import { FireworksBoard } from "@/components/games/fireworks/FireworksBoard";
import { FireworksClueHistory } from "@/components/games/fireworks/FireworksClueHistory";
import { FireworksHand } from "@/components/games/fireworks/FireworksHand";
import { FireworksReplay } from "@/components/games/fireworks/FireworksReplay";
import {
  applyFireworksAction,
  createFireworksGame,
  getCurrentPlayer,
} from "@/lib/games/fireworks/engine";
import { getFireworksPlayerView } from "@/lib/games/fireworks/hidden-view";
import {
  chooseDeterministicFireworksFallback,
  applyFireworksAiResult,
  getFireworksAIModels,
  getFireworksModelApiKey,
  getFireworksModelBaseURL,
  getFireworksModelRunnerToken,
  requestFireworksAiAction,
  type FireworksAIModelOption,
} from "@/lib/games/fireworks/ai";
import type {
  FireworksAction,
  FireworksGameState,
  FireworksPlayer,
} from "@/lib/games/fireworks/types";
import { buildGameAIThinkingInteraction } from "@/lib/games/core/ai-interactions";
import type { GameAIInteraction } from "@/lib/games/core/types";
import type { ReasoningEffort } from "@/lib/db/schema";

type FireworksMode = "pvp" | "pvai" | "aivai";

interface FireworksAIConfig {
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

const EMPTY_AI_CONFIG: FireworksAIConfig = {
  modelId: "",
  reasoningEffort: "none",
};
const FIREWORKS_FALLBACK_TURN_DELAY_MS = 250;

export function FireworksGameClient({
  onBackToGames,
}: {
  onBackToGames?: () => void;
}) {
  const [started, setStarted] = useState(false);
  const [mode, setMode] = useState<FireworksMode>("pvai");
  const [playerCount, setPlayerCount] = useState<2 | 3>(2);
  const [humanPlayerId, setHumanPlayerId] = useState("P1");
  const [models, setModels] = useState<FireworksAIModelOption[]>([]);
  const [aiConfig, setAiConfig] = useState<FireworksAIConfig>(EMPTY_AI_CONFIG);
  const [state, setState] = useState<FireworksGameState>(() =>
    createFireworksGame({ seed: "fireworks-ui" })
  );
  const [aiThinking, setAiThinking] = useState(false);
  const [lastAiInteraction, setLastAiInteraction] =
    useState<GameAIInteraction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const aiRequestRef = useRef(0);

  useEffect(() => {
    try {
      const enabled = getFireworksAIModels();
      setModels(enabled);
      setAiConfig((current) =>
        current.modelId || enabled.length === 0
          ? current
          : { ...current, modelId: enabled[0].modelId }
      );
    } catch (error) {
      console.warn("Failed to load Fireworks models:", error);
    }
  }, []);

  const currentPlayer = getCurrentPlayer(state);
  const currentSeatIsAI = started && state.status === "playing" && isAiSeat(currentPlayer.id);
  const view = useMemo(
    () => getFireworksPlayerView(state, currentPlayer.id),
    [currentPlayer.id, state]
  );
  const canHumanAct =
    started && state.status === "playing" && !aiThinking && !currentSeatIsAI;
  const seatInteraction =
    currentSeatIsAI && aiThinking
      ? buildGameAIThinkingInteraction(currentPlayer.id)
      : lastAiInteraction;

  const startGame = useCallback(() => {
    const players: FireworksPlayer[] = Array.from({ length: playerCount }, (_, index) => {
      const id = `P${index + 1}`;
      return {
        id,
        label: `Player ${id}`,
        kind: mode === "aivai" || (mode === "pvai" && id !== humanPlayerId) ? "ai" : "human",
        modelId:
          mode === "aivai" || (mode === "pvai" && id !== humanPlayerId)
            ? aiConfig.modelId || undefined
            : undefined,
      };
    });
    setState(
      createFireworksGame({
        seed: `fireworks-ui-${Date.now()}`,
        players,
      })
    );
    setMessage(null);
    setLastAiInteraction(null);
    setStarted(true);
  }, [aiConfig.modelId, humanPlayerId, mode, playerCount]);

  const applyAction = useCallback((action: FireworksAction) => {
    setState((current) => {
      try {
        return applyFireworksAction(current, getCurrentPlayer(current).id, action);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Fireworks action failed.");
        return current;
      }
    });
  }, []);

  useEffect(() => {
    if (!currentSeatIsAI || aiThinking) return;
    const requestId = aiRequestRef.current + 1;
    aiRequestRef.current = requestId;
    const abortController = new AbortController();

    async function runAiTurn() {
      setAiThinking(true);
      setMessage(null);
      const requestState = state;
      const player = getCurrentPlayer(requestState);
      try {
        const apiKey = aiConfig.modelId ? getFireworksModelApiKey(aiConfig.modelId) : null;
        const configuredModel =
          aiConfig.modelId && apiKey
            ? { modelId: aiConfig.modelId, apiKey }
            : null;
        if (!configuredModel) {
          await new Promise((resolve) =>
            setTimeout(resolve, FIREWORKS_FALLBACK_TURN_DELAY_MS)
          );
          if (abortController.signal.aborted) return;
        }
        const result =
          configuredModel
            ? await requestFireworksAiAction({
                state: requestState,
                playerId: player.id,
                modelId: configuredModel.modelId,
                reasoningEffort: aiConfig.reasoningEffort,
                apiKey: configuredModel.apiKey,
                baseURL: getFireworksModelBaseURL(aiConfig.modelId),
                runnerToken: getFireworksModelRunnerToken(aiConfig.modelId),
                signal: abortController.signal,
              })
            : {
                action: chooseDeterministicFireworksFallback(requestState, player.id),
                rawResponse: "",
                legal: true,
                fallbackUsed: true,
                latencyMs: 0,
                error: aiConfig.modelId ? "Missing API key." : "No AI model selected.",
              };
        if (aiRequestRef.current !== requestId || abortController.signal.aborted) return;
        if (result.error && aiConfig.modelId) {
          setMessage(`${player.label}: ${result.error} A legal fallback was used.`);
        }
        if (result.action) {
          setLastAiInteraction({
            actorId: player.id,
            gesture: result.fallbackUsed ? "confused" : "confident",
            utterance: result.fallbackUsed
              ? "I need to clean that up."
              : "I like this turn.",
            ...(result.error ? { diagnostics: result.error } : {}),
          });
          setState((current) =>
            current === requestState
              ? applyFireworksAiResult(current, player.id, result)
              : current
          );
        }
      } catch (error) {
        if (aiRequestRef.current !== requestId || abortController.signal.aborted) return;
        setLastAiInteraction({
          actorId: player.id,
          gesture: "confused",
          utterance: "I need to clean that up.",
          diagnostics:
            error instanceof Error ? error.message : "Fireworks AI turn failed.",
        });
        setMessage(error instanceof Error ? error.message : "Fireworks AI turn failed.");
      } finally {
        if (aiRequestRef.current === requestId) setAiThinking(false);
      }
    }

    void runAiTurn();
    return () => {
      abortController.abort();
    };
  }, [aiConfig, aiThinking, currentSeatIsAI, state]);

  if (!started) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center px-4 py-10 sm:px-6">
        {onBackToGames && (
          <Button type="button" variant="outline" className="mb-5 w-fit" onClick={onBackToGames}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to games
          </Button>
        )}
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="max-w-2xl">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Fireworks
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              Cooperative hidden-information cards
            </h1>
            <p className="mt-2 text-slate-600 dark:text-slate-400">
              Build red, blue, and green stacks from 1 to 5. Players see other
              hands, never their own, and communicate through limited legal clues.
            </p>
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <Field label="Mode">
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as FireworksMode)}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
              >
                <option value="pvp">Human seats</option>
                <option value="pvai">Human vs AI team</option>
                <option value="aivai">AI team self-play</option>
              </select>
            </Field>
            <Field label="Players">
              <select
                value={playerCount}
                onChange={(event) => setPlayerCount(Number(event.target.value) as 2 | 3)}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
              >
                <option value={2}>2 players</option>
                <option value={3}>3 players</option>
              </select>
            </Field>
            {mode === "pvai" && (
              <Field label="Human seat">
                <select
                  value={humanPlayerId}
                  onChange={(event) => setHumanPlayerId(event.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                >
                  {Array.from({ length: playerCount }, (_, index) => `P${index + 1}`).map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
              </Field>
            )}
            {mode !== "pvp" && (
              <Field label="AI model">
                <select
                  value={aiConfig.modelId}
                  onChange={(event) =>
                    setAiConfig((current) => ({ ...current, modelId: event.target.value }))
                  }
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                >
                  {models.length === 0 ? (
                    <option value="">Deterministic fallback</option>
                  ) : (
                    models.map((model) => (
                      <option key={model.modelId} value={model.modelId}>
                        {model.displayName}
                      </option>
                    ))
                  )}
                </select>
              </Field>
            )}
          </div>
          <div className="mt-6">
            <Button type="button" onClick={startGame}>
              <SparkIcon mode={mode} />
              Start Fireworks
            </Button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        {onBackToGames && (
          <Button type="button" variant="outline" onClick={onBackToGames}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to games
          </Button>
        )}
        <Button type="button" variant="outline" onClick={startGame}>
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          New game
        </Button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          <FireworksBoard state={state} />
          <FireworksHand view={view} />
          <FireworksReplay state={state} />
        </div>
        <aside className="space-y-5">
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Seat
            </div>
            <div className="mt-2 flex items-center gap-2 text-lg font-semibold">
              {currentSeatIsAI ? <Bot className="h-5 w-5" /> : <User className="h-5 w-5" />}
              {currentPlayer.label}
            </div>
            {aiThinking && (
              <RefreshCw className="mt-3 h-4 w-4 animate-spin text-sky-700 dark:text-sky-300" aria-hidden="true" />
            )}
            <GameAIPresence
              interaction={seatInteraction}
              variant="card"
              className="mt-3"
            />
            {message && (
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-200">
                {message}
              </p>
            )}
          </section>
          <FireworksActionPanel
            view={view}
            disabled={!canHumanAct}
            onAction={applyAction}
          />
          <FireworksClueHistory state={state} />
        </aside>
      </div>
    </main>
  );

  function isAiSeat(playerId: string): boolean {
    if (mode === "aivai") return true;
    if (mode === "pvai") return playerId !== humanPlayerId;
    return false;
  }
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function SparkIcon({ mode }: { mode: FireworksMode }) {
  return mode === "aivai" ? (
    <Bot className="h-4 w-4" aria-hidden="true" />
  ) : (
    <User className="h-4 w-4" aria-hidden="true" />
  );
}

export default FireworksGameClient;
