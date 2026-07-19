"use client";

import type {
  GameAIConfigValue,
  GameAIModelOption,
} from "@/components/games/GameAIConfigPanel";
import { GameAIConfigPanel } from "@/components/games/GameAIConfigPanel";
import { codenamesCompositionLabel } from "@/lib/games/codenames/seats";
import type {
  CodenamesSeatAssignments,
  CodenamesSeatId,
  CodenamesSeatKind,
  CodenamesTeam,
} from "@/lib/games/codenames/types";

interface SeatDef {
  id: CodenamesSeatId;
  roleLabel: string;
  panelTitle: string;
  accent: "red" | "blue";
  config: GameAIConfigValue;
  onChange: (config: GameAIConfigValue) => void;
}

export function CodenamesSetup({
  seatAssignments,
  redSpymasterAI,
  redOperativeAI,
  blueSpymasterAI,
  blueOperativeAI,
  models,
  restoreMoves,
  onSeatKindChange,
  onRedSpymasterAIChange,
  onRedOperativeAIChange,
  onBlueSpymasterAIChange,
  onBlueOperativeAIChange,
  onStart,
  onResume,
  onStartNew,
}: {
  seatAssignments: CodenamesSeatAssignments;
  redSpymasterAI: GameAIConfigValue;
  redOperativeAI: GameAIConfigValue;
  blueSpymasterAI: GameAIConfigValue;
  blueOperativeAI: GameAIConfigValue;
  models: GameAIModelOption[];
  restoreMoves: number | null;
  onSeatKindChange: (seat: CodenamesSeatId, kind: CodenamesSeatKind) => void;
  onRedSpymasterAIChange: (config: GameAIConfigValue) => void;
  onRedOperativeAIChange: (config: GameAIConfigValue) => void;
  onBlueSpymasterAIChange: (config: GameAIConfigValue) => void;
  onBlueOperativeAIChange: (config: GameAIConfigValue) => void;
  onStart: () => void;
  onResume: () => void;
  onStartNew: () => void;
}) {
  const redSeats: SeatDef[] = [
    {
      id: "redSpymaster",
      roleLabel: "Spymaster",
      panelTitle: "Red Spymaster AI",
      accent: "red",
      config: redSpymasterAI,
      onChange: onRedSpymasterAIChange,
    },
    {
      id: "redOperative",
      roleLabel: "Operative",
      panelTitle: "Red Operative AI",
      accent: "red",
      config: redOperativeAI,
      onChange: onRedOperativeAIChange,
    },
  ];
  const blueSeats: SeatDef[] = [
    {
      id: "blueSpymaster",
      roleLabel: "Spymaster",
      panelTitle: "Blue Spymaster AI",
      accent: "blue",
      config: blueSpymasterAI,
      onChange: onBlueSpymasterAIChange,
    },
    {
      id: "blueOperative",
      roleLabel: "Operative",
      panelTitle: "Blue Operative AI",
      accent: "blue",
      config: blueOperativeAI,
      onChange: onBlueOperativeAIChange,
    },
  ];

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
          the assassin. Pick who plays each seat &mdash; human or AI.
        </p>
        <p
          className="mt-3 inline-block rounded-full bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-wide text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
          data-testid="codenames-composition"
        >
          {codenamesCompositionLabel(seatAssignments)}
        </p>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <TeamColumn
          team="red"
          seats={redSeats}
          seatAssignments={seatAssignments}
          models={models}
          onSeatKindChange={onSeatKindChange}
        />
        <TeamColumn
          team="blue"
          seats={blueSeats}
          seatAssignments={seatAssignments}
          models={models}
          onSeatKindChange={onSeatKindChange}
        />
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

function TeamColumn({
  team,
  seats,
  seatAssignments,
  models,
  onSeatKindChange,
}: {
  team: CodenamesTeam;
  seats: SeatDef[];
  seatAssignments: CodenamesSeatAssignments;
  models: GameAIModelOption[];
  onSeatKindChange: (seat: CodenamesSeatId, kind: CodenamesSeatKind) => void;
}) {
  return (
    <div
      className={
        team === "red"
          ? "rounded-xl border border-red-200 bg-red-50/70 p-4 dark:border-red-900 dark:bg-red-950/25"
          : "rounded-xl border border-blue-200 bg-blue-50/70 p-4 dark:border-blue-900 dark:bg-blue-950/25"
      }
    >
      <div className="mb-3 flex items-center gap-2 text-sm font-bold">
        <span
          className={
            team === "red"
              ? "h-3 w-3 rounded-full bg-red-500"
              : "h-3 w-3 rounded-full bg-blue-500"
          }
          aria-hidden="true"
        />
        {team === "red" ? "Red team" : "Blue team"}
      </div>
      <div className="space-y-3">
        {seats.map((seat) => (
          <SeatControl
            key={seat.id}
            seat={seat}
            kind={seatAssignments[seat.id]}
            models={models}
            onSeatKindChange={onSeatKindChange}
          />
        ))}
      </div>
    </div>
  );
}

function SeatControl({
  seat,
  kind,
  models,
  onSeatKindChange,
}: {
  seat: SeatDef;
  kind: CodenamesSeatKind;
  models: GameAIModelOption[];
  onSeatKindChange: (seat: CodenamesSeatId, kind: CodenamesSeatKind) => void;
}) {
  return (
    <div className="rounded-lg border border-white/70 bg-white/80 p-3 dark:border-slate-800 dark:bg-slate-950/50">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-bold">{seat.roleLabel}</span>
        <div
          className="inline-flex overflow-hidden rounded-lg border border-slate-300 text-xs font-bold dark:border-slate-700"
          role="group"
          aria-label={`${seat.roleLabel} player type`}
        >
          <button
            type="button"
            aria-pressed={kind === "human"}
            onClick={() => onSeatKindChange(seat.id, "human")}
            className={
              kind === "human"
                ? "bg-emerald-500 px-3 py-1.5 text-slate-950"
                : "px-3 py-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            }
            data-testid={`codenames-seat-${seat.id}-human`}
          >
            Human
          </button>
          <button
            type="button"
            aria-pressed={kind === "ai"}
            onClick={() => onSeatKindChange(seat.id, "ai")}
            className={
              kind === "ai"
                ? "bg-amber-500 px-3 py-1.5 text-slate-950"
                : "px-3 py-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            }
            data-testid={`codenames-seat-${seat.id}-ai`}
          >
            AI
          </button>
        </div>
      </div>
      {kind === "ai" ? (
        <div className="mt-3">
          <GameAIConfigPanel
            title={seat.panelTitle}
            accent={seat.accent}
            config={seat.config}
            models={models}
            onChange={seat.onChange}
          />
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Human seat &mdash; played locally.
        </p>
      )}
    </div>
  );
}
