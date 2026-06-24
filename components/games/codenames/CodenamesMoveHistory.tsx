"use client";

import { ListChecks } from "lucide-react";
import type { CodenamesMoveRecord } from "@/lib/games/codenames/types";
import { roleText, teamLabel } from "./view-helpers";

export function CodenamesMoveHistory({
  moveHistory,
}: {
  moveHistory: CodenamesMoveRecord[];
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2 font-bold">
          <ListChecks className="h-4 w-4" aria-hidden="true" />
          Moves
        </div>
        <span className="text-sm text-slate-500">{moveHistory.length}</span>
      </div>
      <ol className="max-h-80 overflow-auto p-2">
        {moveHistory.length === 0 ? (
          <li className="px-2 py-4 text-sm text-slate-500">No moves yet.</li>
        ) : (
          moveHistory.map((move, index) => (
            <li
              key={`${move.type}-${move.timestamp}-${index}`}
              className="rounded-lg px-3 py-2 text-sm odd:bg-slate-50 dark:odd:bg-slate-900/60"
            >
              <span className="mr-2 font-mono text-slate-400">{index + 1}.</span>
              {move.type === "clue" && (
                <span>
                  <b>{teamLabel(move.team)}</b> clue: {move.clue.word}{" "}
                  {move.clue.count}
                </span>
              )}
              {move.type === "guess" && (
                <span>
                  <b>{teamLabel(move.team)}</b> guessed {move.word} -{" "}
                  {roleText(move.role)}
                </span>
              )}
              {move.type === "end-turn" && (
                <span>
                  <b>{teamLabel(move.team)}</b> ended turn
                </span>
              )}
            </li>
          ))
        )}
      </ol>
    </section>
  );
}
