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
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    maxTokens: number;
    estimated: boolean;
  };
}

interface DiscussionDiagnosticsProps {
  entries: DiagnosticEntry[];
  connected: boolean;
  active: boolean;
  /**
   * "sidebar" — always-expanded, fits its container (the xl left aside).
   * "footer" — fixed bottom bar, collapsible, closed by default (below xl).
   */
  variant?: "sidebar" | "footer";
  /**
   * Word used for the per-entry counter in the meta line. Defaults to "round";
   * Build mode passes "turn" since each entry is a single model streaming turn,
   * not a discussion round (builds count "waves" instead).
   */
  roundLabel?: string;
  showEntryTokenUsage?: boolean;
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

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function totalTokens(entries: DiagnosticEntry[]): number {
  return entries.reduce(
    (sum, entry) => sum + (entry.tokenUsage?.totalTokens ?? 0),
    0
  );
}

function EntriesList({
  entries,
  roundLabel = "round",
  showEntryTokenUsage = true,
}: {
  entries: DiagnosticEntry[];
  roundLabel?: string;
  showEntryTokenUsage?: boolean;
}) {
  if (entries.length === 0) {
    return (
      <p className="px-2 py-3 text-sm text-muted-foreground">
        No orchestration events recorded yet.
      </p>
    );
  }
  return (
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
              {entry.round !== undefined && (
                <span>
                  · {roundLabel} {entry.round}
                </span>
              )}
              {showEntryTokenUsage && entry.tokenUsage && (
                <span>
                  · ~{formatTokens(entry.tokenUsage.totalTokens)} tokens (
                  {formatTokens(entry.tokenUsage.inputTokens)} in /{" "}
                  {formatTokens(entry.tokenUsage.outputTokens)} out)
                </span>
              )}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function LogHeader({ entries }: { entries: DiagnosticEntry[] }) {
  const tokens = totalTokens(entries);
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Activity className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="font-display text-sm font-semibold">Activity log</span>
      {entries.length > 0 && (
        <span className="font-mono text-xs text-muted-foreground">
          {entries.length}
        </span>
      )}
      {tokens > 0 && (
        <span className="font-mono text-xs text-muted-foreground">
          ~{formatTokens(tokens)} tok
        </span>
      )}
    </span>
  );
}

export function DiscussionDiagnostics({
  entries,
  connected,
  active,
  variant = "footer",
  roundLabel,
  showEntryTokenUsage = true,
}: DiscussionDiagnosticsProps) {
  if (variant === "sidebar") {
    // Always expanded, glanceable during a run; scrolls inside its aside.
    return (
      <section className="flex max-h-[calc(100vh-3rem)] flex-col overflow-hidden rounded-xl border bg-card/60">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <LogHeader entries={entries} />
          <ConnectionPill connected={connected} active={active} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bg-background/40 p-2">
          <EntriesList
            entries={entries}
            roundLabel={roundLabel}
            showEntryTokenUsage={showEntryTokenUsage}
          />
        </div>
      </section>
    );
  }

  return (
    <FooterDiagnostics
      entries={entries}
      connected={connected}
      active={active}
      roundLabel={roundLabel}
      showEntryTokenUsage={showEntryTokenUsage}
    />
  );
}

function FooterDiagnostics({
  entries,
  connected,
  active,
  roundLabel,
  showEntryTokenUsage = true,
}: {
  entries: DiagnosticEntry[];
  connected: boolean;
  active: boolean;
  roundLabel?: string;
  showEntryTokenUsage?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const latest = entries[0];

  return (
    <section className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 shadow-[0_-2px_12px_rgba(0,0,0,0.06)] backdrop-blur">
      {open && (
        <div className="max-h-[min(18rem,32vh)] overflow-y-auto border-b bg-background/40 p-2">
          <EntriesList
            entries={entries}
            roundLabel={roundLabel}
            showEntryTokenUsage={showEntryTokenUsage}
          />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <LogHeader entries={entries} />
          {!open && latest && (
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {latest.message}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <ConnectionPill connected={connected} active={active} />
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        </span>
      </button>
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
