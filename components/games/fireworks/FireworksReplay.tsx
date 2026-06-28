"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FireworksGameState } from "@/lib/games/fireworks/types";

export function FireworksReplay({ state }: { state: FireworksGameState }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Replay export
          </div>
          <h2 className="mt-1 font-semibold">Transcript JSON</h2>
        </div>
        <Button type="button" variant="outline" onClick={() => downloadTranscript(state)}>
          <Download className="h-4 w-4" aria-hidden="true" />
          Export
        </Button>
      </div>
      <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-slate-950 p-3 text-xs leading-relaxed text-slate-100">
        {JSON.stringify(
          {
            id: state.id,
            seed: state.seed,
            status: state.status,
            stacks: state.stacks,
            discardPile: state.discardPile,
            events: state.events,
          },
          null,
          2
        )}
      </pre>
    </section>
  );
}

function downloadTranscript(state: FireworksGameState): void {
  const blob = new Blob([JSON.stringify(state, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fireworks-${state.seed}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
