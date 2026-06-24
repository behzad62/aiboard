"use client";

import { Play, Radar, RotateCcw, Ship, Upload } from "lucide-react";
import {
  GameAIConfigPanel,
  type GameAIConfigValue,
  type GameAIModelOption,
} from "@/components/games/GameAIConfigPanel";
import {
  BATTLESHIP_BOARD_SIZE,
  BATTLESHIP_FLEET,
} from "@/lib/games/battleship/engine";
import type {
  BattleshipGameMode,
  BattleshipPlayer,
} from "@/lib/games/battleship/types";
import { cn } from "@/lib/utils";
import { isAIControlledPlayer, playerLabel } from "./view-helpers";

interface BattleshipSetupProps {
  gameMode: BattleshipGameMode;
  humanPlayer: BattleshipPlayer;
  blueAI: GameAIConfigValue;
  orangeAI: GameAIConfigValue;
  models: GameAIModelOption[];
  restoreMoves: number | null;
  importMessage: string | null;
  onModeChange: (mode: BattleshipGameMode) => void;
  onHumanPlayerChange: (player: BattleshipPlayer) => void;
  onBlueAIChange: (config: GameAIConfigValue) => void;
  onOrangeAIChange: (config: GameAIConfigValue) => void;
  onStart: () => void;
  onStartNew: () => void;
  onResume: () => void;
  onImportClick: () => void;
}

export function BattleshipSetup({
  gameMode,
  humanPlayer,
  blueAI,
  orangeAI,
  models,
  restoreMoves,
  importMessage,
  onModeChange,
  onHumanPlayerChange,
  onBlueAIChange,
  onOrangeAIChange,
  onStart,
  onStartNew,
  onResume,
  onImportClick,
}: BattleshipSetupProps) {
  const blueIsAI = isAIControlledPlayer(gameMode, humanPlayer, "blue");
  const orangeIsAI = isAIControlledPlayer(gameMode, humanPlayer, "orange");

  return (
    <section className="rounded-2xl border border-slate-200 bg-white/90 p-5 shadow-xl dark:border-slate-800 dark:bg-slate-950/90">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
            <Ship className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Battleship</h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              {BATTLESHIP_FLEET.length} ships, {BATTLESHIP_BOARD_SIZE}x
              {BATTLESHIP_BOARD_SIZE} grid
            </p>
          </div>
        </div>
        {restoreMoves !== null && (
          <button
            type="button"
            onClick={onResume}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-800 transition hover:bg-emerald-100 active:scale-95 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
          >
            <Play className="h-4 w-4" aria-hidden="true" />
            Resume {restoreMoves} shots
          </button>
        )}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-5">
          <div>
            <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
              Mode
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {(["pvp", "pvai", "aivai"] as BattleshipGameMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onModeChange(mode)}
                  className={cn(
                    "rounded-lg border px-4 py-3 text-sm font-semibold transition active:scale-95",
                    gameMode === mode
                      ? "border-sky-500 bg-sky-50 text-sky-800 dark:border-sky-500 dark:bg-sky-950/50 dark:text-sky-200"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                  )}
                >
                  {mode === "pvp" && "Player vs Player"}
                  {mode === "pvai" && "Player vs AI"}
                  {mode === "aivai" && "AI vs AI"}
                </button>
              ))}
            </div>
          </div>

          {gameMode === "pvai" && (
            <div>
              <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
                Human side
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {(["blue", "orange"] as BattleshipPlayer[]).map((player) => (
                  <button
                    key={player}
                    type="button"
                    onClick={() => onHumanPlayerChange(player)}
                    className={cn(
                      "rounded-lg border px-4 py-3 text-sm font-semibold transition active:scale-95",
                      humanPlayer === player
                        ? player === "blue"
                          ? "border-sky-500 bg-sky-50 text-sky-800 dark:border-sky-500 dark:bg-sky-950/50 dark:text-sky-200"
                          : "border-orange-500 bg-orange-50 text-orange-800 dark:border-orange-500 dark:bg-orange-950/50 dark:text-orange-200"
                        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                    )}
                  >
                    {playerLabel(player)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {(blueIsAI || orangeIsAI) && models.length === 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-200">
              Configure at least one model in Settings before starting an AI game.
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            {blueIsAI && (
              <GameAIConfigPanel
                title="Blue AI"
                accent="blue"
                config={blueAI}
                models={models}
                onChange={onBlueAIChange}
              />
            )}
            {orangeIsAI && (
              <GameAIConfigPanel
                title="Orange AI"
                accent="orange"
                config={orangeAI}
                models={models}
                onChange={onOrangeAIChange}
              />
            )}
          </div>
        </div>

        <div className="space-y-3">
          <button
            type="button"
            onClick={onStart}
            disabled={(blueIsAI || orangeIsAI) && models.length === 0}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="battleship-start"
          >
            <Radar className="h-4 w-4" aria-hidden="true" />
            Start
          </button>
          <button
            type="button"
            onClick={() => void onStartNew()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            New board
          </button>
          <button
            type="button"
            onClick={onImportClick}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            Import
          </button>
          {importMessage && (
            <div className="text-center text-xs font-medium text-slate-600 dark:text-slate-400">
              {importMessage}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
