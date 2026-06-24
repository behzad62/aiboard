"use client";

import { EyeOff } from "lucide-react";
import type {
  CodenamesPlayerRole,
  CodenamesTeam,
} from "@/lib/games/codenames/types";
import { roleLabel, teamLabel } from "./view-helpers";

export function CodenamesHandoff({
  team,
  role,
  onShow,
}: {
  team: CodenamesTeam;
  role: CodenamesPlayerRole;
  onShow: () => void;
}) {
  return (
    <section className="flex min-h-[34rem] items-center justify-center rounded-2xl border border-slate-200 bg-slate-950 p-6 text-white shadow-xl dark:border-slate-800">
      <div className="max-w-md text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-slate-800 text-amber-200">
          <EyeOff className="h-8 w-8" aria-hidden="true" />
        </div>
        <p className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Private handoff
        </p>
        <h2 className="mt-2 text-3xl font-bold">
          {teamLabel(team)} {roleLabel(role)}
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          Pass the screen to the next seat before showing the board.
        </p>
        <button
          type="button"
          onClick={onShow}
          className="mt-6 rounded-lg border border-amber-500 bg-amber-500 px-4 py-2 text-sm font-bold text-slate-950 transition hover:bg-amber-400 active:scale-95"
          data-testid="codenames-handoff-show"
        >
          Show board
        </button>
      </div>
    </section>
  );
}
