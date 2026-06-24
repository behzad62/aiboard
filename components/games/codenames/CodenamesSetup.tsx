"use client";

import type { GameAIConfigValue, GameAIModelOption } from "@/components/games/GameAIConfigPanel";
import { GameAIConfigPanel } from "@/components/games/GameAIConfigPanel";
import type { CodenamesGameMode, CodenamesTeam } from "@/lib/games/codenames/types";
import { modeLabel, teamLabel } from "./view-helpers";

export function CodenamesSetup({
  gameMode,
  humanTeam,
  redSpymasterAI,
  redOperativeAI,
  blueSpymasterAI,
  blueOperativeAI,
  models,
  restoreMoves,
  onModeChange,
  onHumanTeamChange,
  onRedSpymasterAIChange,
  onRedOperativeAIChange,
  onBlueSpymasterAIChange,
  onBlueOperativeAIChange,
  onStart,
  onResume,
  onStartNew,
}: {
  gameMode: CodenamesGameMode;
  humanTeam: CodenamesTeam;
  redSpymasterAI: GameAIConfigValue;
  redOperativeAI: GameAIConfigValue;
  blueSpymasterAI: GameAIConfigValue;
  blueOperativeAI: GameAIConfigValue;
  models: GameAIModelOption[];
  restoreMoves: number | null;
  onModeChange: (mode: CodenamesGameMode) => void;
  onHumanTeamChange: (team: CodenamesTeam) => void;
  onRedSpymasterAIChange: (config: GameAIConfigValue) => void;
  onRedOperativeAIChange: (config: GameAIConfigValue) => void;
  onBlueSpymasterAIChange: (config: GameAIConfigValue) => void;
  onBlueOperativeAIChange: (config: GameAIConfigValue) => void;
  onStart: () => void;
  onResume: () => void;
  onStartNew: () => void;
}) {
  const showRedAI = gameMode === "aivai" || (gameMode === "pvai" && humanTeam === "blue");
  const showBlueAI = gameMode === "aivai" || (gameMode === "pvai" && humanTeam === "red");

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-950">
      <div className="text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-300">
          Codenames
        </p>
        <h1 className="mt-2 text-4xl font-black text-slate-950 dark:text-white">
          Codenames
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
          Spymasters give one-word clues. Operatives uncover cards without hitting
          the assassin.
        </p>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {(["pvp", "pvai", "aivai"] as CodenamesGameMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => onModeChange(mode)}
            className={`rounded-xl border p-4 text-left transition ${
              gameMode === mode
                ? "border-amber-500 bg-amber-50 text-slate-950 ring-2 ring-amber-300 dark:bg-amber-950/30 dark:text-white"
                : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            }`}
            data-testid={`codenames-mode-${mode}`}
          >
            <div className="font-bold">{modeLabel(mode)}</div>
            <div className="mt-1 text-xs opacity-75">
              {mode === "pvp" && "All seats are local humans"}
              {mode === "pvai" && "Your team plays against AI"}
              {mode === "aivai" && "Both teams are model controlled"}
            </div>
          </button>
        ))}
      </div>

      {gameMode === "pvai" && (
        <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-3 text-sm font-bold">Human team</div>
          <div className="grid grid-cols-2 gap-3">
            {(["red", "blue"] as CodenamesTeam[]).map((team) => (
              <button
                key={team}
                type="button"
                onClick={() => onHumanTeamChange(team)}
                className={`rounded-lg border px-3 py-2 text-sm font-bold transition ${
                  humanTeam === team
                    ? "border-amber-500 bg-amber-500 text-slate-950"
                    : "border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
                }`}
              >
                {teamLabel(team)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {showRedAI && (
          <>
            <GameAIConfigPanel
              title="Red Spymaster AI"
              accent="red"
              config={redSpymasterAI}
              models={models}
              onChange={onRedSpymasterAIChange}
            />
            <GameAIConfigPanel
              title="Red Operative AI"
              accent="red"
              config={redOperativeAI}
              models={models}
              onChange={onRedOperativeAIChange}
            />
          </>
        )}
        {showBlueAI && (
          <>
            <GameAIConfigPanel
              title="Blue Spymaster AI"
              accent="blue"
              config={blueSpymasterAI}
              models={models}
              onChange={onBlueSpymasterAIChange}
            />
            <GameAIConfigPanel
              title="Blue Operative AI"
              accent="blue"
              config={blueOperativeAI}
              models={models}
              onChange={onBlueOperativeAIChange}
            />
          </>
        )}
      </div>

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={onStart}
          className="rounded-lg bg-amber-500 px-5 py-3 text-sm font-black text-slate-950 transition hover:bg-amber-400 active:scale-95"
          data-testid="codenames-start"
        >
          Start game
        </button>
        {restoreMoves !== null && (
          <>
            <button
              type="button"
              onClick={onResume}
              className="rounded-lg border border-emerald-400 bg-emerald-50 px-5 py-3 text-sm font-black text-emerald-800 transition hover:bg-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-200"
            >
              Resume ({restoreMoves})
            </button>
            <button
              type="button"
              onClick={onStartNew}
              className="rounded-lg border border-slate-200 px-5 py-3 text-sm font-bold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
            >
              New game
            </button>
          </>
        )}
      </div>
    </section>
  );
}
