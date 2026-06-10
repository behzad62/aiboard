"use client";

import { useState } from "react";
import { Activity, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OrchestratorEvent } from "@/lib/orchestrator/engine";

export interface DiagnosticEntry {
  id: string;
  at: string;
  phase: Extract<OrchestratorEvent, { type: "diagnostic" }>["phase"];
  message: string;
  modelName?: string;
  providerId?: string;
  round?: number;
}

interface DiscussionDiagnosticsProps {
  entries: DiagnosticEntry[];
  connected: boolean;
  active: boolean;
}

function phaseDot(phase: DiagnosticEntry["phase"]): string {
  switch (phase) {
    case "model_failed":
      return "bg-rose-500";
    case "model_connecting":
    case "model_streaming":
    case "convergence_voting":
    case "judging":
      return "bg-amber-500";
    case "model_completed":
    case "finished":
      return "bg-emerald-500";
    default:
      return "bg-slate-400";
  }
}

export function DiscussionDiagnostics({
  entries,
  connected,
  active,
}: DiscussionDiagnosticsProps) {
  const [open, setOpen] = useState(false);

  return (
    <section className="overflow-hidden rounded-xl border bg-card/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
      >
        <span className="flex items-center gap-2.5">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="font-display text-sm font-semibold">Activity log</span>
          {entries.length > 0 && (
            <span className="font-mono text-xs text-muted-foreground">
              {entries.length}
            </span>
          )}
        </span>
        <span className="flex items-center gap-3">
          <ConnectionPill connected={connected} active={active} />
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        </span>
      </button>

      {open && (
        <div className="max-h-96 overflow-y-auto border-t bg-background/40 p-2">
          {entries.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              No orchestration events recorded yet.
            </p>
          ) : (
            <ol className="space-y-0.5">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-start gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/40"
                >
                  <span className="mt-1 font-mono text-[0.65rem] tabular-nums text-muted-foreground">
                    {entry.at}
                  </span>
                  <span
                    className={cn(
                      "mt-[0.4rem] h-1.5 w-1.5 shrink-0 rounded-full",
                      phaseDot(entry.phase)
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground/90">{entry.message}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 font-mono text-[0.65rem] text-muted-foreground">
                      <span>{entry.phase.replaceAll("_", " ")}</span>
                      {entry.modelName && <span>· {entry.modelName}</span>}
                      {entry.providerId && <span>· {entry.providerId}</span>}
                      {entry.round !== undefined && <span>· round {entry.round}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function ConnectionPill({
  connected,
  active,
}: {
  connected: boolean;
  active: boolean;
}) {
  if (!active) {
    return (
      <span className="font-mono text-[0.7rem] text-muted-foreground">
        stream closed
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[0.7rem]">
      <span className="relative flex h-1.5 w-1.5">
        {connected && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/70" />
        )}
        <span
          className={cn(
            "relative inline-flex h-1.5 w-1.5 rounded-full",
            connected ? "bg-emerald-500" : "bg-amber-500"
          )}
        />
      </span>
      <span
        className={cn(
          connected
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-amber-600 dark:text-amber-400"
        )}
      >
        {connected ? "live" : "reconnecting"}
      </span>
    </span>
  );
}
