"use client";

import { ArrowRight, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  GameAIConfigPanel,
  type GameAIConfigValue,
  type GameAIModelOption,
} from "@/components/games/GameAIConfigPanel";
import type { ConnectFourSessionSnapshot } from "@/lib/games/connect-four/session";
import type {
  ConnectFourGameMode,
  ConnectFourPlayer,
} from "@/lib/games/connect-four/types";
import { ConnectFourImportMenu } from "./ConnectFourImportMenu";

interface ConnectFourSetupProps {
  gameMode: ConnectFourGameMode;
  humanPlayer: ConnectFourPlayer;
  redAI: GameAIConfigValue;
  yellowAI: GameAIConfigValue;
  models: GameAIModelOption[];
  restoreMoves: number | null;
  onModeChange: (mode: ConnectFourGameMode) => void;
  onHumanPlayerChange: (player: ConnectFourPlayer) => void;
  onRedAIChange: (config: GameAIConfigValue) => void;
  onYellowAIChange: (config: GameAIConfigValue) => void;
  onStart: () => void;
  onResume: () => void;
  onStartNew: () => void;
  onImport: (snapshot: ConnectFourSessionSnapshot) => void;
}

const MODE_OPTIONS: Array<{
  mode: ConnectFourGameMode;
  label: string;
  description: string;
}> = [
  {
    mode: "pvp",
    label: "Player vs Player",
    description: "Two humans share the board.",
  },
  {
    mode: "pvai",
    label: "Player vs AI",
    description: "Choose a side and challenge a model.",
  },
  {
    mode: "aivai",
    label: "AI vs AI",
    description: "Let two models play the match.",
  },
];

export function ConnectFourSetup({
  gameMode,
  humanPlayer,
  redAI,
  yellowAI,
  models,
  restoreMoves,
  onModeChange,
  onHumanPlayerChange,
  onRedAIChange,
  onYellowAIChange,
  onStart,
  onResume,
  onStartNew,
  onImport,
}: ConnectFourSetupProps) {
  const redIsAI = gameMode === "aivai" || (gameMode === "pvai" && humanPlayer === "yellow");
  const yellowIsAI = gameMode === "aivai" || (gameMode === "pvai" && humanPlayer === "red");
  const needsAI = redIsAI || yellowIsAI;
  const canStart = !needsAI || models.length > 0;

  return (
    <section className="mx-auto w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="mb-5">
        <p className="text-sm font-semibold uppercase tracking-wide text-red-600 dark:text-red-300">
          Connect Four
        </p>
        <h2 className="mt-2 text-2xl font-bold text-slate-950 dark:text-white">
          Start a match
        </h2>
      </div>

      {restoreMoves !== null && (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                Saved game available
              </p>
              <p className="mt-1 text-sm text-amber-800/80 dark:text-amber-200/75">
                {restoreMoves} move{restoreMoves === 1 ? "" : "s"} recorded.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onResume}
                className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-amber-700 active:scale-95"
              >
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
                Resume
              </button>
              <button
                type="button"
                onClick={onStartNew}
                className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-amber-900 transition hover:bg-amber-100 active:scale-95 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200 dark:hover:bg-amber-950/50"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                New game
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-5">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
            Mode
          </h3>
          <div className="grid gap-2 sm:grid-cols-3">
            {MODE_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                onClick={() => onModeChange(option.mode)}
                className={cn(
                  "rounded-xl border p-3 text-left transition active:scale-[0.99]",
                  gameMode === option.mode
                    ? "border-sky-500 bg-sky-50 text-sky-950 ring-2 ring-sky-200 dark:border-sky-500 dark:bg-sky-950/35 dark:text-sky-100"
                    : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                )}
                aria-pressed={gameMode === option.mode}
                data-testid={`connect-four-mode-${option.mode}`}
              >
                <span className="block text-sm font-semibold">{option.label}</span>
                <span className="mt-1 block text-xs opacity-75">
                  {option.description}
                </span>
              </button>
            ))}
          </div>
        </div>

        {gameMode === "pvai" && (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
              Your side
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <PlayerChoiceButton
                player="red"
                selected={humanPlayer === "red"}
                onClick={() => onHumanPlayerChange("red")}
              />
              <PlayerChoiceButton
                player="yellow"
                selected={humanPlayer === "yellow"}
                onClick={() => onHumanPlayerChange("yellow")}
              />
            </div>
          </div>
        )}

        {needsAI && (
          <div className="grid gap-3 md:grid-cols-2">
            {redIsAI && (
              <GameAIConfigPanel
                title="Red AI"
                accent="red"
                config={redAI}
                models={models}
                onChange={onRedAIChange}
              />
            )}
            {yellowIsAI && (
              <GameAIConfigPanel
                title="Yellow AI"
                accent="yellow"
                config={yellowAI}
                models={models}
                onChange={onYellowAIChange}
              />
            )}
          </div>
        )}

        {needsAI && models.length === 0 && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            Add or enable an AI model before starting this mode.
          </p>
        )}

        <div className="flex flex-col gap-3 border-t border-slate-200 pt-5 dark:border-slate-800 sm:flex-row">
          <button
            type="button"
            onClick={onStart}
            disabled={!canStart}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition active:scale-95",
              canStart
                ? "bg-sky-700 text-white hover:bg-sky-800"
                : "cursor-not-allowed bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-500"
            )}
            data-testid="connect-four-start"
          >
            Start game
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
          <ConnectFourImportMenu
            onImport={onImport}
            className="sm:w-40"
          />
        </div>
      </div>
    </section>
  );
}

interface PlayerChoiceButtonProps {
  player: ConnectFourPlayer;
  selected: boolean;
  onClick: () => void;
}

function PlayerChoiceButton({
  player,
  selected,
  onClick,
}: PlayerChoiceButtonProps) {
  const isRed = player === "red";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 rounded-xl border p-3 text-left transition active:scale-[0.99]",
        selected
          ? "border-amber-400 bg-amber-50 ring-2 ring-amber-200 dark:border-amber-500 dark:bg-amber-950/30"
          : "border-slate-200 bg-slate-50 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800"
      )}
      aria-pressed={selected}
      data-testid={`connect-four-human-${player}`}
    >
      <span
        className={cn(
          "h-5 w-5 rounded-full border-2",
          isRed
            ? "border-red-800 bg-red-500"
            : "border-yellow-700 bg-yellow-400"
        )}
        aria-hidden="true"
      />
      <span className="text-sm font-semibold capitalize text-slate-800 dark:text-slate-200">
        {player}
      </span>
    </button>
  );
}

export default ConnectFourSetup;
